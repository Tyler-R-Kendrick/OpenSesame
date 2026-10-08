"""Test-only discovery of exact pinned vendor sources; never native compiler evidence."""
import os
from pathlib import Path

from contract import decode, regular, require, sha


def vendor_relative(row):
    tail=row['path'].split('/index.crates.io-1949cf8c6b5b557f/',1)
    require(len(tail)==2 and row['path'].startswith('/'),'unknown pinned vendor layout')
    return tail[1]


def vendor_rows(bundle):
    return [r for r in decode(regular(bundle,'outer/source-pins.json').read_bytes())
            if r['path'].startswith('/')]


def exact_registry(root,bundle):
    rows=vendor_rows(bundle)
    require(len(rows)==3,'incomplete pinned vendor set')
    for row in rows:
        require(sha(regular(root,vendor_relative(row)).read_bytes())==row['sha256'],
                'test vendor bytes changed: '+row['name'])
    return root


def resolve_registry(bundle,environment=None,home=None):
    env=os.environ if environment is None else environment
    explicit=env.get('OPENSESAME_EQUIVALENCE_TEST_REGISTRY_ROOT')
    if explicit:
        return exact_registry(Path(explicit).resolve(),bundle)
    cargo=Path(env['CARGO_HOME']).expanduser() if env.get('CARGO_HOME') else (Path.home() if home is None else home)/'.cargo'
    sources=cargo.resolve()/'registry/src'
    require(sources.is_dir(),'missing installed Cargo registry sources')
    entries=list(sources.iterdir());require(len(entries)<=128,'unbounded Cargo registry directories')
    candidates=[]
    for root in entries:
        if root.is_dir() and not root.is_symlink() and root.name.startswith('index.crates.io-'):
            try: candidates.append(exact_registry(root,bundle))
            except ValueError: pass
    require(len(candidates)==1,'missing/ambiguous exact pinned Cargo registry')
    return candidates[0]
