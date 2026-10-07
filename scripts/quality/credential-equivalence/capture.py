"""Evidence-only baseline observer. Never changes the raw cargo-mutants command/result."""
from pathlib import Path
import re
import shlex
import threading
import time

from capture_setup import probe, setup
from contract import LIMITS, decode, regular, require, sha


def commands(raw):
    values = []
    for line in raw.decode().splitlines():
        found = re.fullmatch(r'\s*Running `([^`]+)`\s*',line)
        if found:
            values.append(shlex.split(found[1]))
    return values


def selected(argv):
    if '--crate-name' not in argv or '--crate-type' not in argv:
        return None
    def arg(flag):
        indices = [i for i,x in enumerate(argv) if x==flag]
        require(len(indices)==1 and indices[0]+1<len(argv), 'ambiguous/missing compiler argument')
        return argv[indices[0]+1]
    name,kind = arg('--crate-name'),arg('--crate-type')
    if name != 'opensesame_sealed_store' or kind != 'lib':
        return None
    linked = [argv[i+1][5:] for i,x in enumerate(argv[:-1])
              if x == '--extern' and argv[i+1].startswith('libc=')]
    dirs = [argv[i+1] for i,x in enumerate(argv[:-1]) if x == '--out-dir']
    require(len(linked) == len(dirs) == 1, 'ambiguous baseline dependency invocation')
    rlib,dependency = Path(linked[0]),Path(dirs[0])
    require(rlib.is_absolute() and dependency.is_absolute() and rlib.parent == dependency and
            re.fullmatch(r'liblibc-[0-9a-f]{16}\.rlib',rlib.name), 'unrecognized baseline libc path')
    return rlib,dependency


class BaselineCapture:
    def __init__(self, root, evidence, bundle, context, platform):
        self.root,self.evidence,self.bundle = root,evidence,bundle
        self.stop = threading.Event()
        self.thread = None
        self.error = None
        self.copies = None
        self.observed = None
        self.finished = False
        self.platform = platform
        try:
            digest = sha(regular(bundle,'verifier-inputs.json').read_bytes())
            self.copies,self.policy,self.metadata,self.base = setup(root,evidence,bundle,
                {**context,'platform':platform},digest)
            if platform != 'windows':
                self.thread = threading.Thread(target=self.observe,name='baseline-evidence',daemon=True)
                self.thread.start()
        except Exception as error:
            self.error = str(error)

    def observe(self):
        log = self.evidence/'mutants/mutants.out/log/baseline.log'
        end = time.monotonic()+900
        offset,pending,identity = 0,b'',None
        try:
            while not self.stop.is_set() and time.monotonic()<end:
                if log.is_file() and not log.is_symlink():
                    stat = log.stat()
                    require(stat.st_size<=32*1024*1024 and stat.st_size>=offset, 'baseline log changed/exceeds cap')
                    current = (stat.st_dev,stat.st_ino)
                    require(identity is None or identity==current, 'baseline log replaced')
                    identity = current
                    with log.open('rb') as stream:
                        stream.seek(offset)
                        fresh = stream.read(1024*1024)
                    offset += len(fresh)
                    pending += fresh
                    require(len(pending)<=2*1024*1024, 'unbounded baseline command line')
                    last = pending.rfind(b'\n')
                    if last>=0:
                        complete,pending = pending[:last+1],pending[last+1:]
                        for argv in commands(complete):
                            chosen = selected(argv)
                            if chosen is not None:
                                self.snapshot(argv,*chosen)
                                return
                self.stop.wait(0.05)
            if not self.stop.is_set():
                self.error = 'evidence observation exceeded900s; raw command unchanged'
        except Exception as error:
            self.error = str(error)

    def snapshot(self, argv, rlib, dependency):
        identity = rlib.stem.removeprefix('lib')
        fingerprint = dependency.parent/'.fingerprint'/identity
        require(not rlib.is_symlink() and not fingerprint.is_symlink(), 'symlinked baseline artifact')
        self.copies.add('rlib',rlib,LIMITS['rlib'])
        self.copies.add('fp-json',fingerprint/'lib-libc.json',LIMITS['fp-json'])
        self.copies.add('fp-dep',fingerprint/'dep-lib-libc',LIMITS['fp-dep'])
        self.copies.add('rustc-dep',dependency/(identity+'.d'),LIMITS['rustc-dep'])
        libc = [p for p in self.metadata['packages'] if p['name'] == 'libc' and p['version'] == '0.2.189']
        require(len(libc) == 1, 'unresolved baseline libc')
        manifest = Path(libc[0]['manifest_path'])
        self.copies.add('libc-manifest',manifest,LIMITS['manifest'])
        self.copies.add('libc-checksum',manifest.parent/'.cargo-checksum.json',LIMITS['checksum'])
        self.observed = {'command':argv,'rlib':str(rlib),'dependency':str(dependency),
                         'fingerprint':str(fingerprint),'packageId':libc[0]['id']}

    def finish(self):
        require(not self.finished, 'producer capture finalized twice')
        self.finished = True
        self.stop.set()
        if self.thread is not None:
            self.thread.join()
        try:
            require(self.copies is not None and self.error is None, self.error or 'capture setup failed')
            outcomes_file = regular(self.evidence,'mutants/mutants.out/outcomes.json')
            document = decode(outcomes_file.read_bytes())
            baseline = [r for r in document['outcomes'] if r['scenario'] == 'Baseline']
            require(document['cargo_mutants_version'] == '27.1.0' and len(baseline) == 1 and
                    baseline[0]['summary'] == 'Success', 'baseline did not complete successfully')
            phases = baseline[0]['phase_results']
            require([p['phase'] for p in phases] == ['Build','Test'] and
                    all(p['process_status'] == 'Success' for p in phases), 'baseline phases incomplete')
            log_path = 'mutants/mutants.out/'+baseline[0]['log_path']
            log = regular(self.evidence,log_path)
            require(log.stat().st_size <= 32*1024*1024, 'baseline log exceeds cap')
            baseline_evidence = {'outcomesSha256':sha(outcomes_file.read_bytes()),
                                 'logPath':log_path,'logSha256':sha(log.read_bytes())}
            actual_probe = None
            if self.platform != 'windows':
                require(self.observed is not None and self.observed['command'] in commands(log.read_bytes()),
                        'no actual baseline compiler linkage; no Fresh/cache fallback')
                actual_probe = probe(self.copies,self.bundle,self.base['host'],self.observed['rlib'])
            value = {**self.base,'status':'complete','baseline':baseline_evidence,
                     'selection':self.observed,'probe':actual_probe}
            self.copies.save(value)
            return {'status':'complete','captureSha256':sha(
                regular(self.copies.root,'portable-capture.json').read_bytes())}
        except Exception as error:
            result = {'status':'failure','error':str(error),'rawAdmissionUnchanged':True}
            if self.copies is not None:
                self.copies.save({**getattr(self,'base',{}),**result})
            else:
                directory = self.evidence/'semantic-inputs'
                directory.mkdir(exist_ok=True)
                file = directory/'portable-capture.json'
                with file.open('x') as stream:
                    import json
                    stream.write(json.dumps(result,indent=2)+'\n')
            return result
