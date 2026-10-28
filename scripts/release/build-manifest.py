#!/usr/bin/env python3
"""Validate the exact candidate inventory before hashing or attesting it."""
import hashlib, json, os, pathlib, sys, tarfile
env, root = os.environ, pathlib.Path(sys.argv[1])
tag = 'v' + env['VERSION']
proxy = 'opensesame-surrogate-proxy-TEST-upstream-override'
expected = {f'production/opensesame-pages_{tag}.tar.gz': ('production', 'pages'),
            'production/opensesame-env-parse.mjs': ('production', 'node22')}
for target in ('x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'):
    expected[f'production/opensesame-kit_{tag}_{target}.tar.gz'] = ('production', target)
    expected[f'test-only/{proxy}_{tag}_{target}.tar.gz'] = ('test-only', target)
actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if not p.is_dir()}
if actual != set(expected) or any(p.is_symlink() for p in root.rglob('*')):
    raise SystemExit(f'Output inventory mismatch: expected {sorted(expected)}, found {sorted(actual)}')
bridge = (root / 'production/opensesame-env-parse.mjs').read_bytes()
marker = b'OPENSESAME_SURROGATE_TEST_UPSTREAM'
for name, (_, target) in expected.items():
    if not name.endswith('.tar.gz'): continue
    with tarfile.open(root / name, 'r:gz') as archive:
        files = {}
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise SystemExit(f'Unsafe archive member: {name}: {member.name}')
            if member.isfile():
                if str(path) in files: raise SystemExit('Duplicate archive member')
                files[str(path)] = archive.extractfile(member).read()
        if target == 'pages':
            required = {'index.html', '404.html', 'os-runtime-config.json', 'security-profile.json', 'release.json'}
            if not required <= files.keys(): raise SystemExit('Incomplete production Pages archive')
            release = json.loads(files['release.json'])
            if release.get('revision') != env['SOURCE_SHA']: raise SystemExit('Pages source mismatch')
            profile = json.loads(files['security-profile.json'])
            if profile.get('profile') != 'shared_origin_demo' or profile.get('canonicalOrigin') != 'https://tyler-r-kendrick.github.io':
                raise SystemExit('Wrong Pages deployment profile')
        else:
            directory = pathlib.PurePosixPath(name).name.removesuffix('.tar.gz')
            wanted = {'LICENSE', proxy} if name.startswith('test-only/') else {'LICENSE', 'opensesame', 'opensesame-surrogate-proxy', 'opensesame-env-parse.mjs'}
            if set(files) != {directory + '/' + leaf for leaf in wanted}: raise SystemExit('Native kit membership mismatch')
            if name.startswith('test-only/'):
                if marker not in files[directory + '/' + proxy]: raise SystemExit('Test proxy marker missing')
            else:
                if files[directory + '/opensesame-env-parse.mjs'] != bridge: raise SystemExit('Bridge differs across kits')
                if any(marker in files[directory + '/' + leaf] for leaf in ('opensesame', 'opensesame-surrogate-proxy')):
                    raise SystemExit('Test-only proxy behavior in a production binary')
payloads = []
for path, (role, target) in sorted(expected.items()):
    data = (root / path).read_bytes()
    payloads.append({'path': path, 'role': role, 'target': target, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
manifest = {'format': 'opensesame-candidate', 'schema_version': 1, 'candidate_id': env['CANDIDATE_ID'],
            'source_sha': env['SOURCE_SHA'], 'version': env['VERSION'],
            'producer': {'run_id': env['GITHUB_RUN_ID'], 'run_attempt': env['GITHUB_RUN_ATTEMPT'],
                         'workflow_ref': env['GITHUB_WORKFLOW_REF'], 'workflow_sha': env['GITHUB_WORKFLOW_SHA'],
                         'recipe_path': '.github/workflows/candidate-build.yml'},
            'source_ci': {'run_id': env['SOURCE_CI_RUN_ID'], 'run_attempt': env['SOURCE_CI_RUN_ATTEMPT']},
            'payloads': payloads}
data = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
(root / 'candidate.json').write_bytes(data)
digest = hashlib.sha256(data).hexdigest()
with open(env['GITHUB_OUTPUT'], 'a') as output: output.write(f'payload_digest={digest}\n')
