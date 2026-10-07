import importlib.util
import sys
import re
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

script = Path(__file__).resolve().parents[1] / "scripts/verify-apple-results.py"
spec = importlib.util.spec_from_file_location("apple_results", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AppleResultsTest(unittest.TestCase):
    def fixture(self, names):
        summary = {"passedTests": len(names), "failedTests": 0, "skippedTests": 0}
        tree = {"testNodes": [{"nodeType": "Test Case", "nodeIdentifier": "Suite/" + name + "()", "result": "Passed"} for name in names]}
        return summary, tree

    def test_all_admission_envelope_and_cold_cases_are_required(self):
        names = module.FRAMEWORK | module.ENVELOPE | {module.COLD}
        self.assertEqual(len(module.verify(*self.fixture(names), "cold")), 26)

    def test_required_envelope_catalog_matches_every_upstream_test(self):
        native = Path(__file__).resolve().parents[1]
        paths = [native / "ios/Tests/WalletEnvelopeStorageTests/StorageTests.swift", native / "ios/EnvelopeCore/Tests/WalletEnvelopeCoreTests/EnvelopeTests.swift"]
        names = [name for path in paths for name in re.findall(r"func (test\w+)\(", path.read_text())]
        self.assertEqual(len(names), 9)
        self.assertEqual(set(names), module.ENVELOPE)

    def test_required_framework_catalog_matches_every_admission_test(self):
        directory = Path(__file__).resolve().parents[1] / "ios/Tests/OpenSesameAuthenticatorTests"
        names = [name for path in directory.glob("*.swift")
                 for name in re.findall(r"@Test(?:\([^\n]*\))?\s+func (\w+)\(", path.read_text())]
        self.assertEqual(len(names), 16)
        self.assertEqual(set(names), module.FRAMEWORK)

    def test_envelope_case_missing_duplicate_skip_and_failure_are_blocking(self):
        names = module.FRAMEWORK | module.ENVELOPE | {module.COLD}
        summary, tree = self.fixture(names)
        name = next(iter(module.ENVELOPE))
        for changed in [names - {name}, list(names) + [name]]:
            with self.assertRaises(ValueError): module.verify(summary, self.fixture(changed)[1], "cold")
        for status in ["Skipped", "Failed"]:
            summary, tree = self.fixture(names)
            tree["testNodes"][0]["result"] = status
            with self.assertRaises(ValueError): module.verify(summary, tree, "cold")

    def test_both_real_owner_journeys_are_required_separately(self):
        for name, phase in [(module.PASSWORD, "password"), (module.CANARY, "canary")]:
            self.assertEqual(module.verify(*self.fixture([name]), phase), [name])

    def test_missing_skipped_failed_duplicate_and_foreign_cases_fail(self):
        valid_summary, valid_tree = self.fixture([module.PASSWORD])
        for invalid in [True, "1", None]:
            summary = dict(valid_summary); summary["passedTests"] = invalid
            with self.assertRaises(ValueError): module.verify(summary, valid_tree, "password")
        for key in ["failedTests", "skippedTests", "passedTests"]:
            summary = dict(valid_summary); summary[key] += 1
            with self.assertRaises(ValueError): module.verify(summary, valid_tree, "password")
        for names in [[], [module.PASSWORD, module.PASSWORD], [module.CANARY]]:
            with self.assertRaises(ValueError): module.verify(valid_summary, self.fixture(names)[1], "password")
        with self.assertRaises(ValueError): module.verify(valid_summary, {"testNodes": []}, "password")
        failed_tree = self.fixture([module.PASSWORD])[1]
        failed_tree["testNodes"][0]["result"] = "Skipped"
        with self.assertRaises(ValueError): module.verify(valid_summary, failed_tree, "password")


if __name__ == "__main__":
    unittest.main()
