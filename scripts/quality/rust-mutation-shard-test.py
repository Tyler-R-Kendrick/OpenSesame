#!/usr/bin/env python3
"""Actual temp-artifact fail-closed controls, not mutation/runtime admission."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("rust-mutation-shard-collect.py"))
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
gate = collector.gate


def native_mutant(index):
    return {"name": f"crates/example.rs:{index + 1}:1: replace public read with Ok(())",
            "file": "crates/example.rs", "package": "p", "function": None,
            "span": {"start": {"line": index + 1, "column": 1}, "end": {"line": index + 1, "column": 2}},
            "replacement": "Ok(())", "genre": "FnValue", "diff": "parser fixture diff"}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def fixture(parent):
    source = ["a" * 40, "b" * 40]
    full = [native_mutant(index) for index in range(16)]
    for index in range(8):
        root = parent / f"test-depth-mutation-rust-{index}of8"
        root.mkdir()
        (root / "steps.txt").write_text("\n".join(f"{key}=success" for key in ["checkout", "source", "python", "rust", "tools", "execute", "freshness"]) + "\n")
        (root / "source.txt").write_text("\n".join(source) + "\n")
        write(root / "inputs.before.json", [{"path": "Cargo.lock", "sha256": "captured"}])
        write(root / "inputs.changed-paths.json", [])
        write(root / "python.json", {"version": [3, 11, 0], "os": "posix", "executable": "/actual/python3"})
        evidence = root / "mutation-shard"
        assigned = gate.fixed_partition(full, index)
        write(evidence / "assigned.json", assigned)
        baseline = {"scenario": "Baseline", "summary": "Success", "phase_results": [
            {"phase": "Build", "process_status": "Success"}, {"phase": "Test", "process_status": "Success"}]}
        outcomes = {"cargo_mutants_version": "27.1.0", "outcomes": [baseline] + [
            {"scenario": {"Mutant": {key: value for key, value in mutant.items() if key != "diff"}}, "summary": "CaughtMutant"} for mutant in assigned]}
        raw = evidence / "mutants/mutants.out/outcomes.json"
        write(raw, outcomes)
        (evidence / "campaign.log.exit").write_text("0\n")
        receipt = {"v": 1, "group": "canonical", "platform": "linux", "shard": index, "shards": 8,
                   "source": source, "wholeSourceBeforeSHA256": gate.platform_gate.sha(root / "inputs.before.json"),
                   "sourcePins": {"crates/example.rs": "source fixture digest"}, "compiler": {"host": "native parser fixture"},
                   "canonicalCommand": "exact known fixture command", "fullInventorySHA256": gate.digest(full),
                   "activeInventorySHA256": gate.digest(full), "full": full,
                   "applicability": [{"mutant": value, "active": True, "condition": "original_unfiltered_scope"} for value in full],
                   "active": full, "assigned": assigned, "outcomesSHA256": gate.platform_gate.sha(raw),
                   "admission": gate.platform_gate.outcomes_analyze(outcomes, [{"mutant": value} for value in assigned]), "status": "success"}
        write(evidence / "shard-receipt.json", receipt)
    return source


class ShardAdmissionControls(unittest.TestCase):
    def test_non_native_old_or_missing_python_cannot_admit_actual_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            receipt = root / "test-depth-mutation-rust-0of8/python.json"
            for value in [{"version": [3, 11, 0], "os": "nt", "executable": "python"},
                          {"version": [3, 10, 0], "os": "posix", "executable": "python3"},
                          {"version": [3, True, 0], "os": "posix", "executable": "python3"}, {}]:
                write(receipt, value)
                with self.assertRaises(ValueError):
                    collector.collect(root, "canonical", "success", source)
            receipt.unlink()
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_native_paths_do_not_depend_on_bash_converting_subprocess_arguments(self):
        windows = r"D:\a\_temp\evidence with spaces\mutants"
        self.assertEqual(gate.native_tool_path(windows, "windows", "nt"), windows)
        self.assertEqual(gate.native_tool_path("/tmp/evidence/mutants", "linux", "posix"), "/tmp/evidence/mutants")
        for path, platform, host in [("/d/a/_temp/mutants", "windows", "nt"),
                                    (windows, "windows", "posix"), (windows, "linux", "posix")]:
            with self.assertRaises(ValueError):
                gate.native_tool_path(path, platform, host)

    def test_complete_measured_shape_partitions_and_positive_collector(self):
        with tempfile.TemporaryDirectory() as directory:
            source = fixture(Path(directory))
            result = collector.collect(directory, "canonical", "success", source)
            self.assertEqual(len(result["groups"][0]["shards"]), 8)
            self.assertEqual(result["status"], "success")

    def test_missing_extra_or_failed_matrix_can_never_admit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "failure", source)
            (root / "unexpected").mkdir()
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)
            (root / "unexpected").rmdir()
            (root / "test-depth-mutation-rust-3of8").rename(root / "wrong-shard")
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_source_or_compiler_aba_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", ["c" * 40, source[1]])
            receipt_path = root / "test-depth-mutation-rust-1of8/mutation-shard/shard-receipt.json"
            receipt = json.loads(receipt_path.read_text())
            receipt["compiler"] = {"host": "other fixture"}
            write(receipt_path, receipt)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_overlapping_ids_are_not_union_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            receipt_path = root / "test-depth-mutation-rust-1of8/mutation-shard/shard-receipt.json"
            receipt = json.loads(receipt_path.read_text())
            receipt["shard"] = 0
            write(receipt_path, receipt)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_missing_real_baseline_cannot_be_replaced_by_a_receipt_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            evidence = root / "test-depth-mutation-rust-1of8/mutation-shard"
            report = evidence / "mutants/mutants.out/outcomes.json"
            value = json.loads(report.read_text())
            value["outcomes"] = value["outcomes"][1:]
            write(report, value)
            path = evidence / "shard-receipt.json"
            receipt = json.loads(path.read_text())
            receipt["outcomesSHA256"] = gate.platform_gate.sha(report)
            write(path, receipt)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_unknown_shards_empty_partitions_and_survivor_reports_refuse(self):
        with self.assertRaises(ValueError):
            gate.fixed_partition([native_mutant(0)], 3)
        with self.assertRaises(ValueError):
            gate.fixed_partition([native_mutant(0)], 8)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            report = root / "test-depth-mutation-rust-2of8/mutation-shard/mutants/mutants.out/outcomes.json"
            value = json.loads(report.read_text())
            value["outcomes"][1]["summary"] = "MissedMutant"
            write(report, value)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_prerequisite_skip_changed_source_and_symlink_do_not_admit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            step = root / "test-depth-mutation-rust-0of8/steps.txt"
            step.write_text(step.read_text().replace("execute=success", "execute=skipped"))
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)
            step.write_text(step.read_text().replace("execute=skipped", "execute=success"))
            changed = root / "test-depth-mutation-rust-0of8/inputs.changed-paths.json"
            write(changed, ["crates/example.rs"])
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)
            write(changed, [])
            report = root / "test-depth-mutation-rust-0of8/mutation-shard/mutants/mutants.out/outcomes.json"
            original = report.with_name("retained-native-report.json")
            report.rename(original)
            report.symlink_to(original.name)
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_changed_raw_report_refused_without_matching_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = fixture(root)
            report = root / "test-depth-mutation-rust-0of8/mutation-shard/mutants/mutants.out/outcomes.json"
            report.write_text(report.read_text() + "\n")
            with self.assertRaises(ValueError):
                collector.collect(root, "canonical", "success", source)

    def test_supported_union_requires_all_three_targets_and_unknown_cfg_fails(self):
        rows = []
        full = [native_mutant(0)]
        for platform in ["linux", "windows", "macos"]:
            rows.append({"platform": platform, "identity": {"full": full, "source": ["same", "tree"], "sourcePins": {},
                         "applicability": [{"mutant": full[0], "condition": "unix", "active": platform != "windows"}]}})
        collector.platform_union(rows)
        with self.assertRaises(ValueError):
            collector.platform_union(rows[:2])
        rows[1]["identity"]["applicability"][0]["condition"] = "unknown"
        with self.assertRaises(ValueError):
            collector.platform_union(rows)


if __name__ == "__main__":
    unittest.main()
