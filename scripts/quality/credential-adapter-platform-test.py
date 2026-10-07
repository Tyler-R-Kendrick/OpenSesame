#!/usr/bin/env python3
"""Executed only by parent/hosted controls; these are no campaign substitutes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("platform_gate", Path(__file__).with_name("credential-adapter-platform.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def mutant(line=2, name="native fs candidate", file="crates/example.rs"):
    return {"name": name, "package": "p", "file": file,
            "function": None, "span": {"start": {"line": line, "column": 1}, "end": {"line": line, "column": 2}},
            "replacement": "Ok(())", "genre": "FnValue", "diff": "exact native diff"}


def variants():
    return {"crates/example.rs": {"package": "p", "regions": [
        {"first": 1, "last": 5, "condition": "unix"},
        {"first": 6, "last": 10, "condition": "windows"},
        {"first": 11, "last": 15, "condition": "unsupported"},
        {"first": 16, "last": 20, "condition": "always"}]}}


class NativeApplicabilityControls(unittest.TestCase):
    def test_empty_default_feature_marker_is_allowed_without_admitting_ffi(self):
        gate.require_default_package_features("opensesame-authenticator-core", {'unix', 'feature="default"'})
        gate.require_default_package_features("opensesame-sealed-store", {'unix'})
        for package, bits in [
            ("opensesame-authenticator-core", {'unix'}),
            ("opensesame-authenticator-core", {'unix', 'feature="default"', 'feature="ffi"'}),
            ("opensesame-sealed-store", {'unix', 'feature="default"'}),
            ("unknown", {'unix'}),
        ]:
            with self.assertRaises(ValueError):
                gate.require_default_package_features(package, bits)

    def test_inactive_ids_remain_in_full_inventory_and_active_equivalents_are_selected(self):
        rows = gate.classify([mutant(), mutant(7, "Windows native"), mutant(12, "unsupported stub"), mutant(17, "supported constant candidate")], variants(), {"p": ["unix"]})
        self.assertEqual([row["active"] for row in rows], [True, False, False, True])
        self.assertEqual(len(rows), 4)

    def test_unknown_cfg_and_cross_boundary_span_fail(self):
        review = variants()
        review["crates/example.rs"]["regions"][0]["condition"] = "unknown"
        with self.assertRaises(ValueError):
            gate.classify([mutant()], review, {"p": ["unix"]})
        value = mutant(5)
        value["span"]["end"]["line"] = 6
        with self.assertRaises(ValueError):
            gate.classify([value], variants(), {"p": ["unix"]})

    def test_source_mutation_and_unknown_revision_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "lineage").write_text("actual source")
            (root / "selected").write_text("native adapter")
            configuration = {"lineagePins": {"lineage": gate.sha(root / "lineage")},
                             "files": {"selected": [{"sourceSHA256": gate.sha(root / "selected")} ]}}
            gate.pins_match(root, configuration)
            (root / "selected").write_text("changed native adapter")
            with self.assertRaises(ValueError):
                gate.pins_match(root, configuration)

    def test_exact_selector_is_a_toml_file_not_an_unbounded_windows_argv(self):
        import tomllib
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "exact.toml"
            rows = [{"mutant": mutant(name="native [candidate] (" + str(i) + ") \\ literal")} for i in range(300)]
            gate.write_selector(path, rows)
            parsed = tomllib.loads(path.read_text())
            self.assertEqual(set(parsed), {"examine_re"})
            self.assertEqual(len(parsed["examine_re"]), 300)
            for expression, row in zip(parsed["examine_re"], rows):
                self.assertIsNotNone(gate.re.fullmatch(expression, row["mutant"]["name"]))
            with self.assertRaises(ValueError):
                gate.write_selector(path, [])

    def test_missing_extra_duplicate_and_rewritten_filtered_ids_fail(self):
        expected = [mutant()]
        gate.inventory_equal(expected, expected)
        for actual in ([], [mutant(), mutant(name="unexpected")], [mutant(), mutant()], [mutant(name="changed")]):
            with self.assertRaises(ValueError):
                gate.inventory_equal(actual, expected)

    def test_unknown_package_or_source_does_not_get_a_fallback(self):
        for value in (mutant(file="foreign.rs"), {**mutant(), "package": "foreign"}):
            with self.assertRaises(ValueError):
                gate.classify([value], variants(), {"p": ["unix"]})

    def test_actual_style_outcomes_cannot_admit_survivors_or_zero_baseline(self):
        value = mutant()
        active = [{"mutant": value}]
        baseline = {"scenario": "Baseline", "summary": "Success", "phase_results": [
            {"phase": "Build", "process_status": "Success"}, {"phase": "Test", "process_status": "Success"}]}
        outcome = {"scenario": {"Mutant": {k: v for k, v in value.items() if k != "diff"}}, "summary": "CaughtMutant"}
        document = {"cargo_mutants_version": "27.1.0", "outcomes": [baseline, outcome]}
        self.assertTrue(gate.outcomes_analyze(document, active)["admitted"])
        outcome["summary"] = "MissedMutant"
        self.assertFalse(gate.outcomes_analyze(document, active)["admitted"])
        document["outcomes"] = [outcome]
        with self.assertRaises(ValueError):
            gate.outcomes_analyze(document, active)


if __name__ == "__main__":
    unittest.main()
