#!/usr/bin/env python3
"""Metadata parser controls; these are not execution/campaign substitutes."""
import importlib.util
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("reports", Path(__file__).with_name("credential-rust-report.py"))
reports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reports)


class Reports(unittest.TestCase):
    def report(self):
        summary = {field: {"count": 10, "covered": 3} for field in ("lines", "functions", "branches")}
        return {"data": [{"files": [{"filename": "/fixture/crates/feature.rs", "summary": summary}]}]}

    def test_coverage_reports_real_counts_without_percentage_floor(self):
        result = reports.coverage(self.report(), ["crates/feature.rs"], "/fixture")
        self.assertEqual(result["files"][0]["lines"]["covered"], 3)
        self.assertEqual(result["files"][0]["lines"]["percent"], 30)

    def test_missing_duplicate_uninstrumented_malformed_coverage_refused(self):
        with self.assertRaises(ValueError):
            reports.coverage(self.report(), ["crates/missing.rs"], "/fixture")
        value = self.report()
        value["data"][0]["files"].append(value["data"][0]["files"][0])
        with self.assertRaises(ValueError):
            reports.coverage(value, ["crates/feature.rs"], "/fixture")
        for counter in ({"count": 0, "covered": 0}, {"count": 1, "covered": 2}, {"count": True, "covered": 0}):
            value = self.report()
            value["data"][0]["files"][0]["summary"]["lines"] = counter
            with self.assertRaises(ValueError):
                reports.coverage(value, ["crates/feature.rs"], "/fixture")

    def test_instrumented_but_unexecuted_selected_feature_refused(self):
        for fields in (("lines",), ("functions",), ("lines", "functions")):
            with self.subTest(unexecuted=fields):
                value = self.report()
                for field in fields:
                    value["data"][0]["files"][0]["summary"][field] = {"count": 10, "covered": 0}
                with self.assertRaises(ValueError):
                    reports.coverage(value, ["crates/feature.rs"], "/fixture")

    def test_zero_branch_counters_report_absence_of_branch_measurement(self):
        value = self.report()
        value["data"][0]["files"][0]["summary"]["branches"] = {"count": 0, "covered": 0}
        self.assertIsNone(reports.coverage(value, ["crates/feature.rs"], "/fixture")["files"][0]["branches"]["percent"])

    def test_zero_covered_branches_retain_actual_counters_without_branch_floor(self):
        value = self.report()
        value["data"][0]["files"][0]["summary"]["branches"] = {"count": 10, "covered": 0}
        result = reports.coverage(value, ["crates/feature.rs"], "/fixture")
        self.assertEqual(result["files"][0]["branches"], {"count": 10, "covered": 0, "percent": 0})

    def test_mutation_scope_rejects_empty_missing_and_unexpected_files(self):
        self.assertEqual(reports.mutation_list("crates/feature.rs:2:1: replace true with false", ["crates/feature.rs"])["listedMutants"], 1)
        for raw in ("", "crates/foreign.rs:2:1: replace true with false", "diagnostic only"):
            with self.assertRaises(ValueError):
                reports.mutation_list(raw, ["crates/feature.rs"])

    def test_mutation_summary_refuses_vacuous_missed_timeout_and_missing(self):
        self.assertEqual(reports.mutation_run("8 mutants tested in 12s: 7 caught, 1 unviable")["caught"], 7)
        for raw in ("completed", "8 mutants tested in 12s: 8 unviable", "8 mutants tested in 12s: 7 caught, 1 missed", "8 mutants tested in 12s: 7 caught, 1 timeout"):
            with self.assertRaises(ValueError):
                reports.mutation_run(raw)

    def test_fuzz_refuses_unexecuted_zero_and_ambiguous_summary(self):
        self.assertEqual(reports.fuzz_run("Done 31 runs in 60 second(s)\n")["runs"], 31)
        for raw in ("compiled", "Done 0 runs in 60 second(s)", "Done 1 runs in 60 second(s)\nDone 2 runs in 60 second(s)"):
            with self.assertRaises(ValueError):
                reports.fuzz_run(raw)

    def test_oracle_controls_refuse_missing_duplicate_ignored_failed_summary(self):
        lines = ["test " + name + " ... ok" for name in reports.CONTROL_CASES]
        raw = "\n".join(lines) + "\ntest result: ok. 4 passed; 0 failed; 0 ignored;"
        self.assertEqual(reports.rust_controls(raw)["passed"], 4)
        self.assertEqual(reports.rust_controls(raw.replace("\n", "\r\n"))["passed"], 4)
        for bad in (raw.replace(lines[0], ""), raw + "\n" + lines[0], raw.replace("... ok", "... ignored", 1), raw.replace("... ok", "... FAILED", 1), raw.replace("4 passed", "3 passed")):
            with self.assertRaises(ValueError):
                reports.rust_controls(bad)


if __name__ == "__main__":
    unittest.main()
