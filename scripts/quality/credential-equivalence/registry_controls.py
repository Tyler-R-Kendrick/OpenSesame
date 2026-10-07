"""Real pinned vendor bytes/private roots; no native execution or cache mutation."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from contract import regular
from fixtures import BUNDLE, REGISTRY, job, listing
from registry_support import resolve_registry, vendor_relative, vendor_rows


def install(root):
    root.mkdir(parents=True)
    for row in vendor_rows(BUNDLE):
        relative=vendor_relative(row);target=root/relative;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(regular(REGISTRY,relative).read_bytes())
    return root


class RegistryControls(unittest.TestCase):
    def test_explicit_cargo_home_and_home_default_use_exact_installed_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);first=install(root/'explicit')
            self.assertEqual(resolve_registry(BUNDLE,{'OPENSESAME_EQUIVALENCE_TEST_REGISTRY_ROOT':str(first)}),first)
            cargo=root/'cargo';indexed=install(cargo/'registry/src/index.crates.io-test-fixture')
            self.assertEqual(resolve_registry(BUNDLE,{'CARGO_HOME':str(cargo)}),indexed)
            home=root/'home';default=install(home/'.cargo/registry/src/index.crates.io-test-fixture')
            self.assertEqual(resolve_registry(BUNDLE,{},home),default)

    def test_missing_ambiguous_drifted_or_explicit_invalid_registry_does_not_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);cargo=root/'cargo';first=install(cargo/'registry/src/index.crates.io-first')
            install(cargo/'registry/src/index.crates.io-second')
            with self.assertRaises(ValueError):resolve_registry(BUNDLE,{'CARGO_HOME':str(cargo)})
            for env in ({'CARGO_HOME':str(root/'missing')},
                        {'CARGO_HOME':str(cargo),'OPENSESAME_EQUIVALENCE_TEST_REGISTRY_ROOT':str(root/'missing')}):
                with self.assertRaises(ValueError):resolve_registry(BUNDLE,env)
            path=first/vendor_relative(vendor_rows(BUNDLE)[0]);path.write_bytes(path.read_bytes()+b'changed')
            with self.assertRaises(ValueError):resolve_registry(BUNDLE,{'OPENSESAME_EQUIVALENCE_TEST_REGISTRY_ROOT':str(first)})

    def test_portable_fixture_copies_selected_registry_and_listing_is_self_contained(self):
        self.assertEqual(listing(),json.loads((BUNDLE/'controlled-discovery.json').read_bytes()))
        self.assertEqual(len(listing()),281)
        with tempfile.TemporaryDirectory() as temporary:
            evidence,_,_=job(Path(temporary)/'job','linux',0)
            capture=json.loads((evidence/'semantic-inputs/portable-capture.json').read_text())
            rows={row['role']:row for row in capture['files']}
            for vendor in vendor_rows(BUNDLE):
                copied=rows['outer:'+vendor['name']];origin=REGISTRY/vendor_relative(vendor)
                self.assertEqual(copied['origin'],str(origin))
                raw=(evidence/'semantic-inputs'/copied['path']).read_bytes()
                self.assertEqual(hashlib.sha256(raw).hexdigest(),vendor['sha256'])
                self.assertEqual(raw,regular(REGISTRY,vendor_relative(vendor)).read_bytes())
