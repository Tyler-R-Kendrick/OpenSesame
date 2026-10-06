import importlib.util
import subprocess
import sys
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

    def test_failed_os_command_and_wrong_or_unknown_readback_fail_closed(self):
        for text in [module.ENROLLMENT + " 0", "unknown 1", "", "1"]:
            with patch.object(module.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, text)]):
                with self.assertRaises(ValueError): module.set_enrollment("device", True)
        with patch.object(module.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["notifyutil"])):
            with self.assertRaises(subprocess.CalledProcessError): module.set_enrollment("device", True)


if __name__ == "__main__":
    unittest.main()
