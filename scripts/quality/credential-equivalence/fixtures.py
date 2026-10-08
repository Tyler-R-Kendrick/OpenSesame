"""Controlled parser fixtures. Never baseline/native compilation/authentication evidence."""
import copy
import json
import os
from pathlib import Path

from contract import CODE, Copies, LIMITS, regular, require, sha
import inputs
from registry_support import resolve_registry, vendor_relative

BUNDLE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('OPENSESAME_EQUIVALENCE_TEST_ROOT',Path.cwd())).resolve()
REGISTRY = resolve_registry(BUNDLE)
POLICY = json.loads((BUNDLE/'policy.json').read_text())
SOURCE = ['1'*40,'2'*40]
HOSTS = {'linux':('x86_64-unknown-linux-gnu','x86_64','gnu','unix'),
         'macos':('aarch64-apple-darwin','aarch64','','unix'),
         'windows':('x86_64-pc-windows-msvc','x86_64','msvc','windows')}


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2)+'\n')


def context(evidence,platform):
    host,arch,env,family = HOSTS[platform]
    rust = ('rustc 1.88.0 (6b00bc388 2025-06-23)\nbinary: rustc\n'
            'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc\ncommit-date: 2025-06-23\n'
            'host: '+host+'\nrelease: 1.88.0\nLLVM version: 20.1.5\n')
    cfg = [family,f'target_os="{platform}"',f'target_arch="{arch}"',f'target_env="{env}"']
    raw = {'rustc':rust,'tool':'cargo-mutants 27.1.0','cfg':cfg,
           'packageCfg':{p:sorted(cfg+(['feature="default"'] if p==inputs.PACKAGES[0] else []))
                         for p in inputs.PACKAGES},'cfgInventorySHA256':POLICY['cfgInventorySha256']}
    for name,text in [('rustc.txt',rust),('mutants-version.txt','cargo-mutants 27.1.0\n'),
                      ('native.cfg','\n'.join(cfg)+'\n'),
                      *[(p+'.cfg','\n'.join(bits)+'\n') for p,bits in raw['packageCfg'].items()]]:
        (evidence/name).write_text(text)
        (evidence/(name+'.exit')).write_text('0\n')
    return raw,{'host':host,'os':platform,'arch':arch,'env':env,'family':family,
                'packages':raw['packageCfg']}


def listing():
    # This retained discovery is controlled test data, never executed mutant phases.
    path=regular(BUNDLE,'controlled-discovery.json')
    raw=path.read_bytes()
    require(sha(raw)=='7cb3a6c3eb01517c239f678861479e4edb3258d12cd69a4f92ecf52c8e4357b4',
            'controlled discovery fixture changed')
    return json.loads(raw)


def phases(platform):
    host = HOSTS[platform][0]
    cargo = ('C:\\PRODUCER\\.rustup\\toolchains\\'+'1.88.0-'+host+'\\bin\\cargo.exe'
             if platform=='windows' else '/PRODUCER/.rustup/toolchains/1.88.0-'+host+'/bin/cargo')
    tail = ['--verbose','--package=opensesame-authenticator-core@0.1.0',
            '--package=opensesame-sealed-store@0.1.0']
    return [{'phase':'Build','process_status':'Success','argv':[cargo,'test','--no-run',*tail]},
            {'phase':'Test','process_status':'Success','argv':[cargo,'test',*tail]}]


def portable(evidence,platform,compiler):
    _,ctx = context(evidence,platform)
    win = platform=='windows'
    origin = 'C:\\PRODUCER\\root' if win else '/PRODUCER/root'
    join = lambda p:origin+('\\'+p.replace('/','\\') if win else '/'+p)
    bundle_origin = join('scripts/quality/credential-equivalence')
    copies = Copies(evidence/'semantic-inputs')
    def add(role,path,raw): return copies.bytes(role,path,raw,64*1024*1024)
    manifest = json.loads((BUNDLE/'verifier-inputs.json').read_text())
    for name in CODE: add('code:'+name,bundle_origin+'/'+name,(BUNDLE/name).read_bytes())
    add('verifier-manifest',bundle_origin+'/verifier-inputs.json',(BUNDLE/'verifier-inputs.json').read_bytes())
    owners = []
    for name in inputs.PACKAGES:
        relative = 'crates/'+name.removeprefix('opensesame-')+'/Cargo.toml'
        path = join(relative)
        owners.append({'id':'CONTROLLED '+name,'name':name,'version':'0.1.0','manifest_path':path})
        add('manifest:'+name,path,(ROOT/relative).read_bytes())
    registry = join('registry/libc-0.2.189')
    libc = {'id':'registry+https://github.com/rust-lang/crates.io-index#libc@0.2.189',
            'name':'libc','version':'0.2.189','source':'registry+https://github.com/rust-lang/crates.io-index',
            'manifest_path':registry+('/Cargo.toml' if not win else '\\Cargo.toml'),
            'targets':[{'name':'libc','kind':['lib'],'src_path':registry+'/src/lib.rs'}]}
    metadata = {'version':1,'workspace_root':origin,'packages':[*owners,libc],
                'workspace_members':[p['id'] for p in owners],
                'resolve':{'nodes':[{'id':owners[1]['id'],'deps':[{'name':'libc','pkg':libc['id']}]}]}}
    add('metadata',join('metadata.stdout'),(json.dumps(metadata)+'\n').encode())
    add('metadata-exit',join('metadata.exit'),b'0\n')
    for row in json.loads((BUNDLE/'outer/source-pins.json').read_text()):
        path = regular(REGISTRY,vendor_relative(row)) if row['path'].startswith('/') else ROOT/row['path']
        add('outer:'+row['name'],str(path),path.read_bytes())
    selection,probe = None,None
    baseline_path = 'mutants/mutants.out/log/baseline.log'
    log = b'CONTROLLED baseline fixture; no native execution\n'
    if not win:
        dep = join('target/debug/deps')
        rlib = dep+'/liblibc-0123456789abcdef.rlib'
        fp = join('target/debug/.fingerprint/libc-0123456789abcdef')
        rustc = '/PRODUCER/.rustup/toolchains/1.88.0-'+ctx['host']+'/bin/rustc'
        command = [rustc,'--crate-name','opensesame_sealed_store','--crate-type','lib','src/lib.rs',
                   '--out-dir',dep,'--extern','libc='+rlib]
        log = (' Running `'+ ' '.join(command)+'`\n').encode()
        selection = {'command':command,'rlib':rlib,'dependency':dep,'fingerprint':fp,'packageId':libc['id']}
        add('rlib',rlib,b'CONTROLLED bytes: not an actual native artifact')
        fingerprint = {'rustc':1,'features':'["default", "std"]','target':2,'profile':3,'path':4,'deps':[],
                       'local':[{'CheckDepInfo':{'dep_info':'debug/.fingerprint/libc-0123456789abcdef/dep-lib-libc',
                                                'checksum':False}}],'rustflags':[],'config':5,'compile_kind':0}
        add('fp-json',fp+'/lib-libc.json',json.dumps(fingerprint).encode())
        add('fp-dep',fp+'/dep-lib-libc',b'CONTROLLED binary fingerprint fixture')
        add('rustc-dep',dep+'/libc-0123456789abcdef.d',
            (dep+'/libc-0123456789abcdef.d: '+libc['targets'][0]['src_path']+'\n').encode())
        add('libc-manifest',libc['manifest_path'],b'# CONTROLLED manifest fixture\n')
        add('libc-checksum',registry+'/.cargo-checksum.json',
            json.dumps({'package':POLICY['libcPackageChecksum']}).encode())
        key = f'{platform}:{ctx["arch"]}:{ctx["env"]}'
        out = json.dumps({'v':1,'os':platform,'arch':ctx['arch'],'env':ctx['env'],
                          'flags':POLICY['nativeFlags'][key]}).encode()
        add('probe-stdout',join('probe-run.stdout'),out)
        add('probe-stderr',join('probe-run.stderr'),b'')
        add('probe-binary',join('probe-binary'),b'CONTROLLED not compiled')
        add('probe-compile-exit',join('probe-compile.exit'),b'0\n')
        add('probe-run-exit',join('probe-run.exit'),b'0\n')
        linked = join('captured-deps/liblibc-0123456789abcdef.rlib')
        probe = {'argv':['rustc','+1.88.0','--edition=2021','--crate-name','retired_libc_equivalence_probe',
                        '--crate-type=bin','-C','debuginfo=0','-C','opt-level=0','-L',
                        'dependency='+str(Path(linked).parent),'--extern','libc='+linked,
                        bundle_origin+'/libc-probe.rs','-o',join('probe-binary')],
                 'compileExit':0,'runExit':0,'host':ctx['host'],'originalRlib':rlib,'linkedCopy':linked,
                 'linkedCopySha256':copies.files['rlib']['sha256'],
                 'stdoutSha256':copies.files['probe-stdout']['sha256'],
                 'binarySha256':copies.files['probe-binary']['sha256']}
    file = evidence/baseline_path
    file.parent.mkdir(parents=True,exist_ok=True)
    file.write_bytes(log)
    value = {'v':1,'status':'complete','source':SOURCE,'platform':platform,'host':ctx['host'],
             'codeManifestSha256':sha((BUNDLE/'verifier-inputs.json').read_bytes()),
             'producer':{'root':origin,'evidence':join('evidence/mutation-shard'),'bundle':bundle_origin},
             'metadataCommand':['cargo','+1.88.0','metadata','--locked','--format-version','1',
                                '--filter-platform',ctx['host']],'metadataExit':0,
             'baseline':{'outcomesSha256':sha((evidence/'mutants/mutants.out/outcomes.json').read_bytes()),
                         'logPath':baseline_path,'logSha256':sha(log)},'selection':selection,'probe':probe}
    copies.save(value)
    return ctx


def classification(full,packages):
    import importlib.util
    path = ROOT/'scripts/quality/credential-adapter-platform.py'
    spec = importlib.util.spec_from_file_location('controlled_real_cfg_parser',path)
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    config = json.loads((BUNDLE/'cfg-inventory.json').read_text())
    return parser.classify(full,parser.pins_match(ROOT,config),packages)


def job(directory,platform,index,misses=True):
    evidence = directory/'mutation-shard'
    evidence.mkdir(parents=True)
    (evidence/'source.txt').write_text('\n'.join(SOURCE)+'\n')
    raw,ctx = context(evidence,platform)
    full = listing()
    active = inputs.applicable(ROOT,full,ctx,POLICY,BUNDLE)
    assigned = active[index::8]
    for name,values in [('all-generated.json',full),('active.json',active),('assigned.json',assigned)]:
        write(evidence/name,values)
        (evidence/(name+'.exit')).write_text('0\n')
    known = {site['mutant']['name'] for site in POLICY['sites']}
    outcomes = [{'scenario':'Baseline','summary':'Success','log_path':'log/baseline.log',
                 'phase_results':phases(platform)}]
    counts = {}
    for value in assigned:
        status = 'MissedMutant' if misses and value['name'] in known else 'CaughtMutant'
        counts[status] = counts.get(status,0)+1
        outcomes.append({'scenario':{'Mutant':{k:v for k,v in value.items() if k!='diff'}},
                         'summary':status,'phase_results':phases(platform)})
    write(evidence/'mutants/mutants.out/outcomes.json',{'cargo_mutants_version':'27.1.0','outcomes':outcomes})
    portable(evidence,platform,raw)
    opening = {**POLICY['repoPins'],**{'scripts/quality/credential-equivalence/'+name:
               sha((BUNDLE/name).read_bytes()) for name in (*CODE,'verifier-inputs.json')}}
    opening.update(json.loads((BUNDLE/'repository-code-pins.json').read_text())['files'])
    write(evidence/'source.before.json',opening)
    write(evidence/'source.after.json',opening)
    write(directory/'inputs.before.json',[{'path':p,'kind':'file','sha256':s} for p,s in opening.items()])
    write(directory/'inputs.changed-paths.json',[])
    (directory/'source.txt').write_text('\n'.join(SOURCE)+'\n')
    exit_code = 2 if counts.get('MissedMutant') else 0
    (evidence/'campaign.log.exit').write_text(str(exit_code)+'\n')
    before_root = 'C:\\PRODUCER\\root\\evidence\\mutation-shard' if platform=='windows' else '/PRODUCER/root/evidence/mutation-shard'
    from portable import original
    base = ['cargo','+1.88.0','mutants','--gitignore','true']
    for package in POLICY['adapterScope']['packages']: base.extend(['-p',package])
    for file in POLICY['adapterScope']['files']: base.extend(['--file',file])
    command = base+['--config',str(original(before_root,platform)/'exact-selection.toml'),
                    '--shard',str(index)+'/8','--sharding','round-robin','-j','2',
                    '-o',str(original(before_root,platform)/'mutants')]
    from proof import object_digest
    receipt = {'v':1,'group':'adapters','platform':platform,'shard':index,'shards':8,'source':SOURCE,
               'sourcePins':opening,'wholeSourceBeforeSHA256':sha((directory/'inputs.before.json').read_bytes()),
               'compiler':raw,'full':full,'active':active,'assigned':assigned,'command':command,
               'fullInventorySHA256':object_digest(full),'activeInventorySHA256':object_digest(active),
               'outcomesSHA256':sha((evidence/'mutants/mutants.out/outcomes.json').read_bytes()),
               'status':'failure' if exit_code else 'success','canonicalCommand':None,
               'applicability':classification(full,raw['packageCfg']),
               'admission':{'totals':counts,'admitted':exit_code==0,
                   'qualification':'Applicable equivalents remain in selection and block success when missed; unviable counts are never caught.'}}
    from failure_contract import provenance
    output = original(before_root,platform)/'campaign.log'
    exception = None if exit_code==0 else {'class':'ValueError','message':'Real command failed; retained output: '+str(output)}
    receipt['rawFailureProvenance'] = provenance(exit_code,exit_code==0,exception,output,True,True,exit_code==0,[])
    write(evidence/'shard-receipt.json',receipt)
    (directory/'steps.txt').write_text('\n'.join(k+'='+('failure' if k=='execute' and exit_code else 'success')
        for k in ['checkout','source','python','rust','tools','execute','freshness'])+'\n')
    write(directory/'python.json',{'os':'nt' if platform=='windows' else 'posix',
                                  'version':[3,12,0],'executable':('C:\\PRODUCER\\python.exe' if platform=='windows' else '/PRODUCER/python3')})
    runner_exit = 0 if exit_code==0 else 1
    (evidence/'raw-runner.exit').write_text(str(runner_exit)+'\n')
    (directory/'adapter-raw-runner.exit').write_text(str(runner_exit)+'\n')
    for role in ('stdout','stderr'): (directory/('adapter-raw-runner.'+role)).write_bytes(b'CONTROLLED runner parser fixture')
    python = json.loads((directory/'python.json').read_text())
    source_root = original('C:\\PRODUCER\\root' if platform=='windows' else '/PRODUCER/root',platform)
    write(directory/'adapter-raw-runner.invocation.json',{'v':1,'source':SOURCE,'exit':runner_exit,
         'argv':[python['executable'],'-B',str(source_root/'scripts'/'quality'/'rust-mutation-shard.py'),
                 'adapters',platform,str(index),before_root],
         'stdoutSha256':sha((directory/'adapter-raw-runner.stdout').read_bytes()),
         'stderrSha256':sha((directory/'adapter-raw-runner.stderr').read_bytes())})
    return evidence,receipt,ctx
