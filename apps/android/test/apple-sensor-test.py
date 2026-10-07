import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

script = Path(__file__).resolve().parents[1] / "scripts/apple-biometric-fixture.py"
spec = importlib.util.spec_from_file_location("apple_sensor", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AppleSensorTest(unittest.TestCase):
    def test_enrollment_posts_os_sensor_state_and_requires_readback(self):
        for enabled in [False, True]:
            value = "1" if enabled else "0"
            read = subprocess.CompletedProcess([], 0, module.ENROLLMENT + " " + value + "\n")
            with patch.object(module.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0), read]) as run:
                module.set_enrollment("device", enabled)
                self.assertEqual(run.call_args_list[0].args[0],
                    ["xcrun", "simctl", "spawn", "device", "notifyutil", "-s", module.ENROLLMENT, value, "-p", module.ENROLLMENT])
                self.assertEqual(run.call_args_list[1].args[0][-2:], ["-g", module.ENROLLMENT])
                self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))
                self.assertTrue(all(call.kwargs["timeout"] == 5 for call in run.call_args_list))

    def test_failed_os_command_and_wrong_or_unknown_readback_fail_closed(self):
        for text in [module.ENROLLMENT + " 0", "unknown 1", "", "1"]:
            with patch.object(module.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, text)]):
                with self.assertRaises(ValueError): module.set_enrollment("device", True)
        with patch.object(module.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["notifyutil"])):
            with self.assertRaises(subprocess.CalledProcessError): module.set_enrollment("device", True)

    def test_readiness_is_a_separate_process_before_notification_rpc_and_readback(self):
        results = [subprocess.CompletedProcess([], 0, "usage", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, module.ENROLLMENT + " 1", "")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=results) as run:
                module.configure("device", True, output)
            self.assertEqual(run.call_args_list[0].args[0],
                             ["xcrun", "simctl", "spawn", "device", "notifyutil", "-h"])
            evidence = json.loads(output.read_text())
            self.assertEqual([item["stage"] for item in evidence["stages"]],
                             ["process_readiness", "set_and_post", "readback"])
            self.assertTrue(evidence["readbackMatched"])
            self.assertTrue(all(item["timeoutSeconds"] == 5 for item in evidence["stages"]))
            self.assertTrue(all(item["elapsedSeconds"] >= 0 for item in evidence["stages"]))

    def test_failed_readiness_never_attempts_sensor_mutation(self):
        failure = subprocess.TimeoutExpired(["notifyutil", "-h"], 5, b"partial", b"launch")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=failure) as run:
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    module.configure("device", False, output)
            self.assertIs(caught.exception, failure)
            self.assertEqual(run.call_count, 1)
            evidence = json.loads(output.read_text())
            self.assertFalse(evidence["readbackMatched"])
            self.assertEqual(evidence["stages"][0]["status"], "timed_out")
            self.assertEqual(evidence["stages"][0]["stderr"], "launch")

    def test_real_subprocess_timeout_preserves_partial_outputs_and_original_failure(self):
        records = []
        children = []
        original_popen = subprocess.Popen

        def spawn(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            children.append(child)
            return child

        command = [sys.executable, "-c",
                   "import sys,time;print('started',flush=True);print('pending',file=sys.stderr,flush=True);time.sleep(10)"]
        with patch.object(module.subprocess, "Popen", side_effect=spawn):
            with self.assertRaises(subprocess.TimeoutExpired):
                module.sensor_command(command, "process_readiness", records)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["status"], "timed_out")
        self.assertEqual(records[0]["stdout"].strip(), "started")
        self.assertEqual(records[0]["stderr"].strip(), "pending")

    def test_failed_diagnostic_writer_does_not_mask_original_os_failure(self):
        failure = subprocess.CalledProcessError(17, ["notifyutil"])
        with tempfile.TemporaryDirectory() as directory:
            # A directory cannot be opened as the diagnostic file.
            with patch.object(module.subprocess, "run", side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    module.configure("device", False, Path(directory))
            self.assertIs(caught.exception, failure)

    def test_successful_sensor_with_missing_diagnostics_is_not_accepted(self):
        results = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, module.ENROLLMENT + " 0", "")]
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module.subprocess, "run", side_effect=results):
                with self.assertRaises(OSError): module.configure("device", False, Path(directory))

    def test_diagnostic_outputs_are_bounded_and_failed_readback_stays_false(self):
        self.assertEqual(len(module.command_output(b"x" * 8192)), 4096)
        results = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, "unknown 1", "")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=results):
                with self.assertRaises(ValueError): module.configure("device", True, output)
            self.assertFalse(json.loads(output.read_text())["readbackMatched"])


if __name__ == "__main__":
    unittest.main()
