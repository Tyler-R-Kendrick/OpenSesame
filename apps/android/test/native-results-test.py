#!/usr/bin/env python3
"""Behavioral controls for the exact native result verifier, not platform proof."""
import importlib.util
from pathlib import Path
import tempfile
import sys
import unittest
import xml.etree.ElementTree as ET

path = Path(__file__).parents[1] / "scripts" / "verify-native-results.py"
spec = importlib.util.spec_from_file_location("native_results", path)
verifier = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(verifier)


def rust_log(group):
    cases = verifier.CATALOG["rust"][group]
    return "\n".join([*(f"test {name} ... ok" for name in cases), f"test result: ok. {len(cases)} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;"])


def device_log():
    lines = []
    for suite, names in verifier.CATALOG["androidDevice"].items():
        for name in names:
            for status in (1, 0):
                lines.extend([f"INSTRUMENTATION_STATUS: class={suite}", f"INSTRUMENTATION_STATUS: test={name}", f"INSTRUMENTATION_STATUS_CODE: {status}"])
    return "\n".join([*lines, "OK (12 tests)", "INSTRUMENTATION_CODE: -1"])


def write_jvm(directory):
    for suite, names in verifier.CATALOG["jvm"].items():
        root = ET.Element("testsuite", tests=str(len(names)), failures="0", errors="0", skipped="0")
        for name in names:
            ET.SubElement(root, "testcase", classname=suite, name=name)
        ET.ElementTree(root).write(Path(directory) / f"TEST-{suite}.xml")


class NativeResults(unittest.TestCase):
    def test_all_current_rust_groups_require_their_exact_cases(self):
        for group, cases in verifier.CATALOG["rust"].items():
            with self.subTest(group=group):
                self.assertEqual(verifier.rust(rust_log(group), group)["passed"], len(cases))

    def test_rust_missing_duplicate_ignored_failed_and_zero_summary_refuse(self):
        text = rust_log("canaries")
        line = text.splitlines()[0]
        for changed in [text.replace(line, ""), text + "\n" + line, text.replace(line, line.replace("ok", "ignored")), text.replace(line, line.replace("ok", "FAILED")), text.replace("14 passed", "0 passed"), "test result: ok. 0 passed; 0 failed; 0 ignored;"]:
            with self.subTest(changed=changed[-60:]), self.assertRaises(ValueError):
                verifier.rust(changed, "canaries")

    def test_windows_crlf_preserves_exact_rust_case_guards(self):
        text = rust_log("retired").replace("\n", "\r\n")
        self.assertEqual(verifier.rust(text, "retired")["passed"], 6)
        line = text.split("\r\n")[0]
        for changed in (text.replace(line, "", 1), text + "\r\n" + line, text.replace(line, line.replace("ok", "ignored")), text.replace(line, line.replace("ok", "FAILED"))):
            with self.subTest(changed=changed[-60:]), self.assertRaises(ValueError):
                verifier.rust(changed, "retired")

    def test_exact_twenty_six_jvm_cases_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            write_jvm(directory)
            self.assertEqual(verifier.jvm(directory)["passed"], 26)

    def test_jvm_missing_duplicate_skipped_failed_and_count_mismatch_refuse(self):
        for mutation in ("missing", "duplicate", "skipped", "failure", "count"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                write_jvm(directory)
                path = next(Path(directory).glob("*.xml"))
                tree = ET.parse(path)
                root = tree.getroot()
                case = root.find("testcase")
                if mutation == "missing":
                    root.remove(case)
                    root.set("tests", str(int(root.get("tests")) - 1))
                elif mutation == "duplicate":
                    root.append(ET.fromstring(ET.tostring(case)))
                    root.set("tests", str(int(root.get("tests")) + 1))
                elif mutation == "count":
                    root.set("tests", "0")
                else:
                    ET.SubElement(case, mutation)
                tree.write(path)
                with self.assertRaises(ValueError):
                    verifier.jvm(directory)

    def test_twelve_named_device_cases_pass_for_both_page_sizes(self):
        for pages in (4096, 16384):
            self.assertEqual(verifier.android(device_log(), pages)["passed"], 12)

    def test_swift_requires_each_actual_program_completion_once(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, marker in verifier.CATALOG["swiftPrograms"].items():
                Path(directory, name + ".log").write_text(marker + "\n")
            self.assertEqual(verifier.swift(directory)["passedPrograms"], 3)
            path = Path(directory, "swift-canary.log")
            marker = path.read_text()
            for invalid in ("", marker + marker, "FAILED\n" + marker):
                path.write_text(invalid)
                with self.assertRaises(ValueError):
                    verifier.swift(directory)

    def test_device_missing_duplicate_skipped_failed_and_incomplete_refuse(self):
        text = device_log()
        block = "\n".join(text.splitlines()[:3])
        for changed in [text.replace(block, "", 1), block + "\n" + text, text.replace("INSTRUMENTATION_STATUS_CODE: 0", "INSTRUMENTATION_STATUS_CODE: -4", 1), text.replace("INSTRUMENTATION_STATUS_CODE: 0", "INSTRUMENTATION_STATUS_CODE: -2", 1), text.replace("OK (12 tests)", "OK (11 tests)"), text.replace("INSTRUMENTATION_CODE: -1", "INSTRUMENTATION_CODE: 0"), text + "\nINSTRUMENTATION_STATUS: class=unfinished"]:
            with self.subTest(changed=changed[-60:]), self.assertRaises(ValueError):
                verifier.android(changed, 4096)


if __name__ == "__main__":
    unittest.main()
