"""Closed portable evidence schema. Producer paths are opaque provenance strings."""
import hashlib
import json
from pathlib import Path, PurePosixPath

CODE = ('proof.py','inputs.py','provenance.py','portable.py','contract.py','capture.py',
        'capture_setup.py','collect.py','policy.json','cfg-inventory.json',
        'outer/verify.py','outer/source-pins.json','libc-probe.rs','failure_contract.py',
        'classification.py','adapter_classified_run.py','classified_collect.py',
        'requirement-policy.json','repository-code-pins.json','runner-source.py','runner_invocation.py','raw_collector_contract.py')
LIMITS = {'rlib':64*1024*1024,'metadata':32*1024*1024,'fp-json':1024*1024,
          'fp-dep':8*1024*1024,'rustc-dep':8*1024*1024,'code':1024*1024,'outer':4*1024*1024,
          'manifest':1024*1024,'checksum':1024*1024,'probe-stdout':1024*1024,
          'probe-stderr':1024*1024,'probe-binary':16*1024*1024}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def pairs(values):
    answer = {}
    for key,value in values:
        require(key not in answer, 'duplicate portable JSON key')
        answer[key] = value
    return answer


def decode(raw):
    require(len(raw) <= 32*1024*1024, 'unbounded portable JSON')
    return json.loads(raw,object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False,'nonfinite portable JSON'))


def regular(root, relative):
    require(type(relative) is str and relative and '\\' not in relative,
            'bad portable relative path')
    parts = PurePosixPath(relative).parts
    require(not PurePosixPath(relative).is_absolute() and str(PurePosixPath(relative))==relative and
            all(p not in ('..','.') for p in parts),
            'foreign portable path')
    file = root.joinpath(*parts)
    current = root
    for part in parts:
        current = current/part
        require(not current.is_symlink(), 'symlinked portable path')
    require(file.is_file() and file.resolve().is_relative_to(root.resolve()), 'missing portable file')
    return file


def copied(capture, row, limit):
    require(isinstance(row,dict) and set(row) == {'role','origin','path','sha256','size'},
            'unknown portable file shape')
    require(type(row['origin']) is str and row['origin'] and type(row['size']) is int and
            0 <= row['size'] <= limit, 'invalid portable file identity/size')
    file = regular(capture,row['path'])
    require(file.stat().st_size == row['size'], 'portable file size differs')
    raw = file.read_bytes()
    require(sha(raw) == row['sha256'], 'portable file bytes differ')
    return file,raw


def code_binding(bundle, expected):
    raw = regular(bundle,'verifier-inputs.json').read_bytes()
    require(sha(raw) == expected, 'code manifest differs from authenticated caller')
    manifest = decode(raw)
    require(set(manifest) == {'v','files'} and manifest['v'] == 1 and
            set(manifest['files']) == set(CODE), 'incomplete/unknown code manifest')
    for name,digest in manifest['files'].items():
        require(sha(regular(bundle,name).read_bytes()) == digest, 'code/input drift: '+name)
    return manifest


def stable_read(path, limit):
    require(path.is_absolute() and not path.is_symlink() and
            all(not p.is_symlink() for p in path.parents) and path.is_file(), 'bad producer input')
    first = path.stat()
    require(first.st_size <= limit, 'producer evidence exceeds bound')
    raw = path.read_bytes()
    second = path.stat()
    again = path.read_bytes()
    third = path.stat()
    identity = lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
    require(identity(first) == identity(second) == identity(third) and raw == again and
            len(raw) == first.st_size, 'producer evidence changed while copying')
    return raw


class Copies:
    def __init__(self, directory):
        self.root = directory
        directory.mkdir(exist_ok=False)
        (directory/'files').mkdir()
        self.files = {}

    def add(self, role, path, limit):
        require(role not in self.files, 'duplicate captured role')
        raw = stable_read(path,limit)
        return self.bytes(role,str(path),raw,limit)

    def bytes(self, role, origin, raw, limit):
        require(role not in self.files and len(raw) <= limit, 'duplicate/unbounded captured file')
        relative = f'files/{len(self.files):03d}.bin'
        with (self.root/relative).open('xb') as stream:
            stream.write(raw)
        row = {'role':role,'origin':origin,'path':relative,'sha256':sha(raw),'size':len(raw)}
        self.files[role] = row
        return row

    def save(self, value):
        with (self.root/'portable-capture.json').open('x') as stream:
            stream.write(json.dumps({**value,'files':list(self.files.values())},indent=2)+'\n')
