"""Private prepared input checks. No tool execution or campaign rewriting."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tomllib

PACKAGES = ('opensesame-authenticator-core', 'opensesame-sealed-store')
HOSTS = {
    'x86_64-unknown-linux-gnu': ('linux', 'x86_64', 'gnu', 'unix'),
    'aarch64-unknown-linux-gnu': ('linux', 'aarch64', 'gnu', 'unix'),
    'x86_64-apple-darwin': ('macos', 'x86_64', '', 'unix'),
    'aarch64-apple-darwin': ('macos', 'aarch64', '', 'unix'),
    'x86_64-pc-windows-msvc': ('windows', 'x86_64', 'msvc', 'windows'),
}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def read_json(path):
    raw = path.read_bytes()
    require(len(raw) <= 32 * 1024 * 1024, 'unbounded proof JSON')
    return json.loads(raw, object_pairs_hook=object_pairs,
                      parse_constant=lambda _: require(False, 'nonfinite JSON'))


def ordinary(root, relative):
    path = root / relative
    require(not path.is_symlink() and path.is_file() and
            path.resolve().is_relative_to(root.resolve()), 'foreign/nonregular proof input: '+relative)
    return path


def capture(evidence, name):
    path = ordinary(evidence, name)
    exit_path = ordinary(evidence, name + '.exit')
    require(exit_path.read_text().strip() == '0', 'native capture failed: '+name)
    return path.read_text()


def cfg_validate(raw, expected, required_features=()):
    lines = raw.splitlines() if isinstance(raw, str) else raw
    require(isinstance(lines, list) and all(type(x) is str for x in lines), 'bad cfg receipt')
    require(len(set(lines)) == len(lines), 'duplicate cfg receipt')
    os_name, arch, env, family = expected
    wanted = {'target_os':os_name, 'target_arch':arch, 'target_env':env}
    for key, value in wanted.items():
        actual = [line for line in lines if line.startswith(key+'=')]
        require(actual == [f'{key}="{value}"'], 'unknown native cfg: '+key)
    require(family in lines and ('windows' if family == 'unix' else 'unix') not in lines,
            'contradictory/unsupported target family')
    actual_features = {line for line in lines if line.startswith('feature=')}
    require(actual_features == set(required_features), 'missing/unreviewed package default features')
    return sorted(lines)


def native_context(evidence, receipt):
    rust = capture(evidence, 'rustc.txt')
    require(rust.splitlines()[0] == 'rustc 1.88.0 (6b00bc388 2025-06-23)', 'unknown Rust version')
    for line in ['binary: rustc','commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc',
                 'commit-date: 2025-06-23','release: 1.88.0']:
        require(rust.splitlines().count(line) == 1, 'unreviewed compiler build metadata')
    hosts = re.findall(r'^host: (\S+)$', rust, re.M)
    require(len(hosts) == 1 and hosts[0] in HOSTS, 'unreviewed native host')
    host = hosts[0]
    expected = HOSTS[host]
    tool = capture(evidence, 'mutants-version.txt').strip()
    require(tool == 'cargo-mutants 27.1.0', 'unknown mutation tool')
    cfg = capture(evidence, 'native.cfg')
    cfg_validate(cfg, expected)
    packages = {name:cfg_validate(capture(evidence, name+'.cfg'), expected,
                                ('feature="default"',) if name == PACKAGES[0] else ())
                for name in PACKAGES}
    compiler = receipt['compiler']
    require(compiler['rustc'] == rust and compiler['tool'] == tool and
            compiler['cfg'] == cfg.splitlines() and compiler['packageCfg'] == packages,
            'compiler receipt disagrees with raw captures')
    require(receipt['platform'] == expected[0], 'wrong platform receipt')
    return {'host':host, 'os':expected[0], 'arch':expected[1], 'env':expected[2],
            'family':expected[3], 'packages':packages}


def source_inputs(root, policy):
    for path, digest in policy['repoPins'].items():
        require(sha(ordinary(root, path).read_bytes()) == digest, 'reviewed source changed: '+path)
    for path in ('.cargo/mutants.toml', '.cargo/config', '.cargo/config.toml'):
        require(not (root / path).exists(), 'unreviewed compiler/mutation configuration')
    lock = tomllib.loads(ordinary(root, 'Cargo.lock').read_text())
    require([p['version'] for p in lock['package'] if p['name'] == 'libc'] == ['0.2.189'],
            'unreviewed libc graph')


def whole_inputs(evidence, receipt, policy):
    path = ordinary(evidence.parent, 'inputs.before.json')
    require(sha(path.read_bytes()) == receipt['wholeSourceBeforeSHA256'], 'whole-source capture drift')
    rows = read_json(path)
    require(isinstance(rows,list), 'unknown whole-source capture')
    names = [row['path'] for row in rows]
    require(len(names) == len(set(names)), 'duplicate whole-source path')
    files = {row['path']:row['sha256'] for row in rows if row['kind'] == 'file'}
    require(all(files.get(path) == digest for path,digest in policy['repoPins'].items()),
            'whole-source capture missing/different reviewed input')
    require(read_json(ordinary(evidence.parent,'inputs.changed-paths.json')) == [],
            'whole-source closing freshness failed')


def applicable(root, full, context, policy, bundle):
    configuration = ordinary(bundle,'cfg-inventory.json')
    require(sha(configuration.read_bytes()) == policy['cfgInventorySha256'], 'cfg inventory changed')
    config = read_json(configuration)
    variants = {}
    for path, alternatives in config['files'].items():
        actual = sha(ordinary(root,path).read_bytes())
        matching = [x for x in alternatives if x['sourceSHA256'] == actual]
        require(len(matching) == 1, 'unknown source-cfg revision')
        variants[path] = matching[0]
    active = []
    represented = set()
    for mutant in full:
        path, package = mutant['file'], mutant['package']
        require(path in variants and package in context['packages'] and
                variants[path]['package'] == package, 'unknown native scope')
        start,end = mutant['span']['start'],mutant['span']['end']
        require(all(type(point[k]) is int and point[k] > 0 for point in (start,end)
                    for k in ('line','column')), 'malformed native source span')
        require((start['line'],start['column']) < (end['line'],end['column']), 'reversed native source span')
        matches = [x for x in variants[path]['regions'] if
                   x['first'] <= start['line'] <= end['line'] <= x['last']]
        require(len(matches) == 1, 'unreviewed cfg span')
        condition = matches[0]['condition']
        domains = {'always':True,'supported':True,'unix':context['family']=='unix',
                   'windows':context['family']=='windows','unsupported':False}
        require(condition in domains, 'unknown/test cfg condition')
        if domains[condition]:
            active.append(mutant)
        represented.add(path)
    require(represented == set(variants), 'missing original source scope')
    return active


def outer_proof(root, registry, bundle, policy, output, portable_evidence=None):
    module_path = ordinary(bundle, 'outer/verify.py')
    pin_path = ordinary(bundle, 'outer/source-pins.json')
    require(sha(module_path.read_bytes()) == policy['outerVerifierSha256'] and
            sha(pin_path.read_bytes()) == policy['outerPinFileSha256'], 'outer checker drift')
    pins = read_json(pin_path)
    rebased = []
    for row in pins:
        path = row['path']
        if portable_evidence is not None:
            actual = portable_evidence.file('outer:'+row['name'])
        elif path.startswith('/'):
            tail = path.split('/index.crates.io-1949cf8c6b5b557f/', 1)
            require(len(tail) == 2, 'unreviewed dependency source layout')
            actual = ordinary(registry, tail[1])
        else:
            actual = ordinary(root, path)
        require(sha(actual.read_bytes()) == row['sha256'], 'outer source drift')
        rebased.append({**row, 'absolutePath':str(actual)})
    spec = importlib.util.spec_from_file_location('reviewed_outer_proof', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Only paths/output location are rebased; reviewed source digests and code remain exact.
    module.PIN = rebased
    module.HERE = output
    module.main()
    result = read_json(output / 'verification.json')
    require(result['negativeControlCount'] == 13 and len(result['controls']) == 13 and
            all(x['status'] == 'rejected' for x in result['controls']), 'outer controls incomplete')
    require(result['bounds'] == policy['outerBounds'], 'outer arithmetic disagrees')
    return result


def native_flags(evidence, context, bundle, policy, portable_evidence):
    require(context['family']=='unix' and portable_evidence is not None, 'missing actual portable Unix evidence')
    return portable_evidence.flags
