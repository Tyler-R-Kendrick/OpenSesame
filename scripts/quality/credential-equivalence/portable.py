"""Independent portable replay. Original producer paths are never dereferenced."""
from pathlib import Path, PurePosixPath, PureWindowsPath
import re

from contract import CODE, LIMITS, code_binding, copied, decode, regular, require, sha
from capture import commands


def original(value, platform):
    require(type(value) is str and value, 'missing original producer path')
    path = PureWindowsPath(value) if platform == 'windows' else PurePosixPath(value)
    require(path.is_absolute() and '..' not in path.parts, 'noncanonical original path')
    return path


def baseline(document, platform, host, versions):
    found = [r for r in document['outcomes'] if r['scenario'] == 'Baseline']
    require(document['cargo_mutants_version'] == '27.1.0' and len(found) == 1 and
            found[0]['summary'] == 'Success', 'missing/failed genuine baseline')
    phases = found[0]['phase_results']
    require([p['phase'] for p in phases] == ['Build','Test'] and
            all(p['process_status'] == 'Success' for p in phases), 'incomplete baseline phases')
    for phase in phases:
        argv = phase['argv']
        cargo = original(argv[0],platform)
        require(cargo.name == ('cargo.exe' if platform == 'windows' else 'cargo') and
                cargo.parent.parent.name == '1.88.0-'+host, 'unknown baseline native compiler')
        wanted = ['test']+(['--no-run'] if phase['phase']=='Build' else [])+['--verbose',
                  '--package=opensesame-authenticator-core@'+versions['opensesame-authenticator-core'],
                  '--package=opensesame-sealed-store@'+versions['opensesame-sealed-store']]
        require(argv[1:] == wanted, 'baseline command/features changed')
    return found[0]


class Evidence:
    def __init__(self, evidence, context, bundle, policy, expected_manifest):
        self.root = evidence/'semantic-inputs'
        self.value = decode(regular(self.root,'portable-capture.json').read_bytes())
        value = self.value
        wanted = {'v','status','source','platform','host','codeManifestSha256','producer',
                  'metadataCommand','metadataExit','baseline','selection','probe','files'}
        require(set(value) == wanted and value['v'] == 1 and value['status']=='complete',
                'producer evidence not complete/known')
        require(value['source'] == regular(evidence,'source.txt').read_text().splitlines() and
                value['host']==context['host'] and value['platform']==context['os'] and
                value['codeManifestSha256']==expected_manifest, 'producer source/context/code differs')
        require(set(value['producer']) == {'root','evidence','bundle'}, 'unknown producer roots')
        for path in value['producer'].values(): original(path,context['os'])
        self.rows = {}
        paths = set()
        for row in value['files']:
            role = row['role']
            require(role not in self.rows and row['path'] not in paths, 'duplicate portable role/path')
            self.rows[role] = row
            paths.add(row['path'])
        roles = {'verifier-manifest','metadata','metadata-exit',
                 'manifest:opensesame-authenticator-core','manifest:opensesame-sealed-store'}
        roles.update('code:'+name for name in CODE)
        pins = decode(regular(bundle,'outer/source-pins.json').read_bytes())
        roles.update('outer:'+pin['name'] for pin in pins)
        if context['family']=='unix':
            roles.update({'rlib','fp-json','fp-dep','rustc-dep','libc-manifest','libc-checksum',
                          'probe-stdout','probe-stderr','probe-binary','probe-compile-exit','probe-run-exit'})
        require(set(self.rows)==roles, 'incomplete/unknown portable roles')
        for role in roles: self.bytes(role)
        filepaths = {str(p.relative_to(self.root)) for p in (self.root/'files').iterdir()}
        require(filepaths==paths, 'unlisted/missing portable copied file')
        manifest = code_binding(bundle,expected_manifest)
        require(sha(self.bytes('verifier-manifest'))==expected_manifest, 'producer code manifest differs')
        for name,digest in manifest['files'].items():
            require(sha(self.bytes('code:'+name))==digest, 'producer/collector code differs')
        for pin in pins:
            require(sha(self.bytes('outer:'+pin['name']))==pin['sha256'], 'outer source copied bytes differ')
        self.metadata = self.graph(context,policy)
        self.baseline = self.baseline_link(evidence,context)
        if context['family']=='unix': self.artifact_link(context,policy)
        else: require(value['selection'] is None and value['probe'] is None, 'Windows invents Unix proof')

    def bytes(self, role):
        if role.startswith('code:'): limit = LIMITS['code']
        elif role.startswith('outer:'): limit = LIMITS['outer']
        elif role.startswith('manifest:') or role.endswith('-exit'): limit = LIMITS['manifest']
        else: limit = LIMITS.get(role,LIMITS['manifest'])
        return copied(self.root,self.rows[role],limit)[1]

    def file(self,role):
        self.bytes(role)
        return regular(self.root,self.rows[role]['path'])

    def graph(self,context,policy):
        value = self.value
        require(value['metadataCommand']==['cargo','+1.88.0','metadata','--locked','--format-version','1',
                '--filter-platform',context['host']] and type(value['metadataExit']) is int and
                value['metadataExit']==0 and self.bytes('metadata-exit').strip()==b'0', 'graph producer failed')
        metadata = decode(self.bytes('metadata'))
        require(metadata['version']==1 and metadata['resolve'] is not None and
                original(metadata['workspace_root'],context['os'])==
                original(value['producer']['root'],context['os']), 'graph differs from producer checkout')
        packages = metadata['packages']
        require(len({p['id'] for p in packages})==len(packages), 'duplicate graph package')
        self.owners = {}
        for name in ('opensesame-authenticator-core','opensesame-sealed-store'):
            found = [p for p in packages if p['name']==name]
            require(len(found)==1 and found[0]['id'] in metadata['workspace_members'], 'missing graph owner')
            self.owners[name] = found[0]
            relative = 'crates/'+name.removeprefix('opensesame-')+'/Cargo.toml'
            require(sha(self.bytes('manifest:'+name))==policy['repoPins'][relative] and
                    original(self.rows['manifest:'+name]['origin'],context['os'])==
                    original(found[0]['manifest_path'],context['os']), 'owner manifest differs')
        return metadata

    def baseline_link(self,evidence,context):
        value = self.value['baseline']
        require(set(value)=={'outcomesSha256','logPath','logSha256'}, 'unknown baseline link')
        raw = regular(evidence,'mutants/mutants.out/outcomes.json').read_bytes()
        require(len(raw)<=32*1024*1024 and sha(raw)==value['outcomesSha256'], 'raw baseline/outcome drift')
        found = baseline(decode(raw),context['os'],context['host'],
                         {name:p['version'] for name,p in self.owners.items()})
        require(value['logPath']=='mutants/mutants.out/'+found['log_path'], 'foreign baseline log')
        log = regular(evidence,value['logPath'])
        require(log.stat().st_size<=32*1024*1024 and sha(log.read_bytes())==value['logSha256'],
                'baseline log changed')
        return log.read_bytes()

    def artifact_link(self,context,policy):
        selected = self.value['selection']
        require(isinstance(selected,dict) and set(selected)==
                {'command','rlib','dependency','fingerprint','packageId'}, 'unknown baseline selection')
        command = selected['command']
        require(command in commands(self.baseline), 'selected compile not in actual baseline log')
        require(original(command[0],context['os']).parent.parent.name=='1.88.0-'+context['host'] and
                original(command[0],context['os']).name=='rustc', 'different actual baseline rustc')
        def arg(flag):
            indices = [i for i,x in enumerate(command) if x==flag]
            require(len(indices)==1 and indices[0]+1<len(command), 'ambiguous baseline argument')
            return command[indices[0]+1]
        rlib = original(selected['rlib'],context['os'])
        dep = original(selected['dependency'],context['os'])
        require(arg('--crate-name')=='opensesame_sealed_store' and arg('--crate-type')=='lib' and
                original(arg('--out-dir'),context['os'])==dep and rlib.parent==dep and
                re.fullmatch(r'liblibc-[0-9a-f]{16}\.rlib',rlib.name), 'wrong owning baseline invocation')
        extern = [command[i+1] for i,x in enumerate(command[:-1]) if x=='--extern' and
                  command[i+1].startswith('libc=')]
        require(extern==['libc='+selected['rlib']] and not any(x.startswith('--target') for x in command) and
                not any(x=='--cfg' and command[i+1].startswith('feature=')
                        for i,x in enumerate(command[:-1])), 'changed baseline linkage/target/features')
        require(original(self.rows['rlib']['origin'],context['os'])==rlib, 'copied artifact not selected')
        identity = rlib.stem.removeprefix('lib')
        fp_dir = dep.parent/'.fingerprint'/identity
        require(original(selected['fingerprint'],context['os'])==fp_dir, 'wrong fingerprint identity')
        for role,name in [('fp-json','lib-libc.json'),('fp-dep','dep-lib-libc')]:
            require(original(self.rows[role]['origin'],context['os'])==fp_dir/name, 'different copied fingerprint')
        require(original(self.rows['rustc-dep']['origin'],context['os'])==dep/(identity+'.d'), 'wrong dep-info')
        fp = decode(self.bytes('fp-json'))
        required = {'rustc','features','target','profile','path','deps','local','rustflags','config','compile_kind'}
        require(required<=set(fp)<=required|{'declared_features'} and fp['rustflags']==[] and
                fp['compile_kind']==0 and isinstance(decode(fp['features']),list), 'fingerprint differs')
        local = fp['local']
        require(len(local)==1 and set(local[0])=={'CheckDepInfo'} and
                PurePosixPath(local[0]['CheckDepInfo']['dep_info']).parts[-3:]==
                ('.fingerprint',identity,'dep-lib-libc') and self.bytes('fp-dep'), 'bad fingerprint dep-info')
        libc = [p for p in self.metadata['packages'] if p['name']=='libc']
        require(len(libc)==1 and libc[0]['id']==selected['packageId'] and libc[0]['version']=='0.2.189' and
                libc[0]['source']=='registry+https://github.com/rust-lang/crates.io-index', 'different resolved libc')
        source = original(libc[0]['manifest_path'],context['os']).parent
        require(original(self.rows['libc-manifest']['origin'],context['os'])==source/'Cargo.toml' and
                original(self.rows['libc-checksum']['origin'],context['os'])==source/'.cargo-checksum.json' and
                decode(self.bytes('libc-checksum'))['package']==policy['libcPackageChecksum'], 'different libc source')
        nodes = self.metadata['resolve']['nodes']
        owner = self.owners['opensesame-sealed-store']['id']
        found = [n for n in nodes if n['id']==owner]
        require(len({n['id'] for n in nodes})==len(nodes) and len(found)==1 and
                any(d['name']=='libc' and d['pkg']==libc[0]['id'] for d in found[0]['deps']), 'no owning dependency edge')
        targets = [t for t in libc[0]['targets'] if t['name']=='libc' and t['kind']==['lib']]
        require(len(targets)==1, 'ambiguous libc source target')
        target = targets[0]['src_path']
        dep_text = self.bytes('rustc-dep').decode()
        require(not re.search(r'\s',target) and dep_text.startswith(str(dep/(identity+'.d'))+': ') and
                re.search(r'(?<!\S)'+re.escape(target)+r'(?=\s|$)',dep_text), 'dep-info not resolved source')
        self.probe_link(context,policy)

    def probe_link(self,context,policy):
        value = self.value['probe']
        require(set(value)=={'argv','compileExit','runExit','host','originalRlib','linkedCopy',
                            'linkedCopySha256','stdoutSha256','binarySha256'}, 'unknown probe receipt')
        require(type(value['compileExit']) is int and type(value['runExit']) is int and
                value['compileExit']==value['runExit']==0 and self.bytes('probe-compile-exit').strip()==b'0' and
                self.bytes('probe-run-exit').strip()==b'0' and value['host']==context['host'], 'probe failed/wrong host')
        argv = value['argv']
        require(len(argv)==17 and argv[:11]==['rustc','+1.88.0','--edition=2021','--crate-name',
                'retired_libc_equivalence_probe','--crate-type=bin','-C','debuginfo=0','-C','opt-level=0','-L'] and
                argv[11].startswith('dependency=') and argv[12]=='--extern' and argv[15]=='-o', 'probe argv changed')
        linked = original(value['linkedCopy'],context['os'])
        require(argv[13]=='libc='+value['linkedCopy'] and argv[11]=='dependency='+str(linked.parent) and
                original(argv[14],context['os'])==original(self.value['producer']['bundle'],context['os'])/'libc-probe.rs' and
                value['originalRlib']==self.value['selection']['rlib'] and
                value['linkedCopySha256']==self.rows['rlib']['sha256'], 'probe did not link captured baseline bytes')
        require(value['stdoutSha256']==self.rows['probe-stdout']['sha256'] and
                value['binarySha256']==self.rows['probe-binary']['sha256'], 'probe output changed')
        output = decode(self.bytes('probe-stdout'))
        require(set(output)=={'v','os','arch','env','flags'} and output['v']==1 and
                (output['os'],output['arch'],output['env'])==(context['os'],context['arch'],context['env']),
                'different actual probe target')
        key = f'{context["os"]}:{context["arch"]}:{context["env"]}'
        require(output['flags']==policy['nativeFlags'].get(key) and
                all(type(v) is int and v>=0 for v in output['flags'].values()), 'unknown native constants')
        self.flags = output['flags']
