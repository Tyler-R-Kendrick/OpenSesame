"""Producer setup/copy/probe only; never substitutes a build for an actual baseline."""
from pathlib import Path
import subprocess

from contract import Copies, LIMITS, code_binding, decode, regular, require, sha


def run(args, prefix):
    with prefix.with_suffix('.stdout').open('xb') as out, prefix.with_suffix('.stderr').open('xb') as err:
        result = subprocess.run(args,stdout=out,stderr=err,check=False)
    prefix.with_suffix('.exit').write_text(str(result.returncode)+'\n')
    return result.returncode


def setup(root, evidence, bundle, context, expected_manifest):
    manifest = code_binding(bundle,expected_manifest)
    policy = decode(regular(bundle,'policy.json').read_bytes())
    for relative,digest in policy['repoPins'].items():
        require(sha(regular(root,relative).read_bytes()) == digest, 'producer reviewed source drift')
    copies = Copies(evidence/'semantic-inputs')
    for name in manifest['files']:
        copies.add('code:'+name,regular(bundle,name),LIMITS['code'])
    copies.add('verifier-manifest',regular(bundle,'verifier-inputs.json'),LIMITS['manifest'])
    source = regular(evidence,'source.txt').read_text().splitlines()
    host = [s.removeprefix('host: ') for s in context['rustc'].splitlines() if s.startswith('host: ')]
    require(len(host) == 1 and len(source) == 2, 'missing source/native host')
    argv = ['cargo','+1.88.0','metadata','--locked','--format-version','1','--filter-platform',host[0]]
    prefix = copies.root/'metadata'
    exit_code = run(argv,prefix)
    require(exit_code == 0, 'locked metadata failed; no alternate build')
    row = copies.add('metadata',prefix.with_suffix('.stdout'),LIMITS['metadata'])
    copies.add('metadata-exit',prefix.with_suffix('.exit'),LIMITS['manifest'])
    metadata = decode((copies.root/row['path']).read_bytes())
    require(metadata['version'] == 1 and metadata['resolve'] is not None, 'incomplete Cargo graph')
    for name in ('opensesame-authenticator-core','opensesame-sealed-store'):
        packages = [p for p in metadata['packages'] if p['name'] == name]
        require(len(packages) == 1, 'ambiguous owning package')
        copies.add('manifest:'+name,Path(packages[0]['manifest_path']),LIMITS['manifest'])
    pins = decode(regular(bundle,'outer/source-pins.json').read_bytes())
    for pin in pins:
        relative = pin['path']
        if relative.startswith('/'):
            tail = relative.split('/index.crates.io-1949cf8c6b5b557f/',1)
            require(len(tail) == 2, 'unknown dependency layout')
            directory,child = tail[1].split('/',1)
            packages = [p for p in metadata['packages'] if Path(p['manifest_path']).parent.name == directory]
            require(len(packages) == 1, 'dependency source missing/ambiguous')
            file = Path(packages[0]['manifest_path']).parent/child
        else:
            file = regular(root,relative)
        row = copies.add('outer:'+pin['name'],file,LIMITS['outer'])
        require(row['sha256'] == pin['sha256'], 'outer dependency/source changed')
    base = {'v':1,'status':'pending','source':source,'platform':context['platform'],
            'host':host[0],'codeManifestSha256':expected_manifest,
            'producer':{'root':str(root),'evidence':str(evidence),'bundle':str(bundle)},
            'metadataCommand':argv,'metadataExit':exit_code}
    return copies,policy,metadata,base


def probe(copies, bundle, host, original):
    deps = copies.root/'probe-deps'
    deps.mkdir()
    row = copies.files['rlib']
    target = deps/Path(original).name
    with target.open('xb') as file:
        file.write(regular(copies.root,row['path']).read_bytes())
    source = regular(bundle,'libc-probe.rs')
    binary = copies.root/'libc-probe'
    argv = ['rustc','+1.88.0','--edition=2021','--crate-name','retired_libc_equivalence_probe',
            '--crate-type=bin','-C','debuginfo=0','-C','opt-level=0','-L','dependency='+str(deps),
            '--extern','libc='+str(target),str(source),'-o',str(binary)]
    compile_exit = run(argv,copies.root/'probe-compile')
    require(compile_exit == 0, 'copied actual libc probe compile failed')
    run_exit = run([str(binary)],copies.root/'probe-run')
    require(run_exit == 0, 'actual native libc probe run failed')
    copies.add('probe-compile-exit',copies.root/'probe-compile.exit',LIMITS['manifest'])
    copies.add('probe-run-exit',copies.root/'probe-run.exit',LIMITS['manifest'])
    out = copies.add('probe-stdout',copies.root/'probe-run.stdout',LIMITS['probe-stdout'])
    copies.add('probe-stderr',copies.root/'probe-run.stderr',LIMITS['probe-stderr'])
    compiled = copies.add('probe-binary',binary,LIMITS['probe-binary'])
    return {'argv':argv,'compileExit':compile_exit,'runExit':run_exit,'host':host,
            'originalRlib':original,'linkedCopy':str(target),'linkedCopySha256':sha(target.read_bytes()),
            'stdoutSha256':out['sha256'],'binarySha256':compiled['sha256']}
