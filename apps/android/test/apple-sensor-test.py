import importlib.util
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

script = Path(__file__).resolve().parents[1] / "scripts/apple-biometric-fixture.py"
spec = importlib.util.spec_from_file_location("apple_sensor", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def capture_run_port(results):
    remaining = iter(results)

    def run(_args, **kwargs):
        result = next(remaining)
        for name in ["stdout", "stderr"]:
            value = getattr(result, name, None)
            if name == "stdout" and isinstance(result, subprocess.CalledProcessError):
                value = result.output
            if isinstance(value, str):
                value = value.encode("utf-8")
            kwargs[name].write(value or b"")
            kwargs[name].flush()
        if isinstance(result, BaseException):
            raise result
        return result

    return run


@contextmanager
def retained_output_parent(test):
    """Real POSIX transport control, not an Apple simulator or authority fixture."""
    release_read, release_write = os.pipe()
    ready_read, ready_write = os.pipe()
    children = []
    holder_pid = None
    watcher = None
    watcher_fd = None
    original_popen = subprocess.Popen
    command = [sys.executable, "-c", """
import os,sys
release,ready = map(int, sys.argv[1:])
pid = os.fork()
if pid == 0:
    os.write(ready, (str(os.getpid()) + "\\n").encode("ascii"))
    os.close(ready)
    os.read(release, 1)
    os.close(release)
    os._exit(0)
os.close(release)
os.close(ready)
print("owned command completed", flush=True)
os._exit(0)
""", str(release_read), str(ready_write)]

    def spawn(*args, **kwargs):
        test.assertEqual(args[0], command)
        child = original_popen(*args, **kwargs, pass_fds=(release_read, ready_write), start_new_session=True)
        children.append(child)
        return child

    def holder_running():
        nonlocal holder_pid, watcher, watcher_fd
        if holder_pid is None:
            test.assertTrue(select.select([ready_read], [], [], 5)[0], "Owned descendant did not identify itself")
            holder_pid = int(os.read(ready_read, 64).strip())
            test.assertEqual(len(children), 1)
            test.assertEqual(os.getpgid(holder_pid), children[0].pid)
            if hasattr(os, "pidfd_open"):
                watcher_fd = os.pidfd_open(holder_pid)
            else:
                watcher = select.kqueue()
                event = select.kevent(holder_pid, filter=select.KQ_FILTER_PROC,
                                      flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                      fflags=select.KQ_NOTE_EXIT)
                watcher.control([event], 0, 0)
        return os.getpgid(holder_pid) == children[0].pid

    def wait_holder():
        if watcher_fd is not None:
            return bool(select.select([watcher_fd], [], [], 5)[0])
        return bool(watcher.control(None, 1, 5))

    try:
        with patch.object(module.subprocess, "Popen", side_effect=spawn):
            yield command, children, holder_running
    finally:
        try:
            if children:
                holder_running()
            os.close(release_write)
            release_write = None
            if children and not wait_holder():
                # Only the identified live descendant's original owned group can be killed.
                test.assertEqual(os.getpgid(holder_pid), children[0].pid)
                os.killpg(children[0].pid, signal.SIGKILL)
                test.assertTrue(wait_holder(), "Owned descendant did not terminate")
            for child in children:
                child.wait(timeout=5)
        finally:
            for fd in [release_read, release_write, ready_read, ready_write, watcher_fd]:
                if fd is not None:
                    os.close(fd)
            if watcher is not None:
                watcher.close()


class AppleSensorTest(unittest.TestCase):
    def test_enrollment_posts_os_sensor_state_and_requires_readback(self):
        for enabled in [False, True]:
            value = "1" if enabled else "0"
            read = subprocess.CompletedProcess([], 0, module.ENROLLMENT + " " + value + "\n")
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([subprocess.CompletedProcess([], 0), read])) as run:
                module.set_enrollment("device", enabled)
                self.assertEqual(run.call_args_list[0].args[0],
                    ["xcrun", "simctl", "spawn", "device", "notifyutil", "-s", module.ENROLLMENT, value, "-p", module.ENROLLMENT])
                self.assertEqual(run.call_args_list[1].args[0][-2:], ["-g", module.ENROLLMENT])
                self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))
                self.assertTrue(all(call.kwargs["timeout"] == 5 for call in run.call_args_list))

    def test_failed_os_command_and_wrong_or_unknown_readback_fail_closed(self):
        for text in [module.ENROLLMENT + " 0", "unknown 1", "", "1"]:
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, text)])):
                with self.assertRaises(ValueError): module.set_enrollment("device", True)
        with patch.object(module.subprocess, "run", side_effect=capture_run_port([subprocess.CalledProcessError(1, ["notifyutil"])])):
            with self.assertRaises(subprocess.CalledProcessError): module.set_enrollment("device", True)

    def test_readiness_is_a_separate_process_before_notification_rpc_and_readback(self):
        results = [subprocess.CompletedProcess([], 0, "usage", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, module.ENROLLMENT + " 1", "")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=capture_run_port(results)) as run:
                module.configure("device", True, output)
            self.assertEqual(run.call_args_list[0].args[0],
                             ["xcrun", "simctl", "spawn", "device", "notifyutil", "-h"])
            evidence = json.loads(output.read_text())
            self.assertEqual([item["stage"] for item in evidence["stages"]],
                             ["process_readiness", "set_and_post", "readback"])
            self.assertTrue(evidence["readbackMatched"])
            self.assertTrue(all(item["timeoutSeconds"] == 5 for item in evidence["stages"]))
            self.assertTrue(all(item["elapsedSeconds"] >= 0 for item in evidence["stages"]))

    def test_exhausted_readiness_never_attempts_sensor_mutation(self):
        failure = subprocess.TimeoutExpired(["notifyutil", "-h"], 5, b"partial", b"launch")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([failure] * 3)) as run:
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    module.configure("device", False, output)
            self.assertIs(caught.exception, failure)
            self.assertEqual(run.call_count, 3)
            evidence = json.loads(output.read_text())
            self.assertFalse(evidence["readbackMatched"])
            self.assertEqual([item["attempt"] for item in evidence["stages"]], [1, 2, 3])
            self.assertTrue(all(item["status"] == "timed_out" for item in evidence["stages"]))
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
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([failure])):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    module.configure("device", False, Path(directory))
            self.assertIs(caught.exception, failure)

    def test_successful_sensor_with_missing_diagnostics_is_not_accepted(self):
        results = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, module.ENROLLMENT + " 0", "")]
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module.subprocess, "run", side_effect=capture_run_port(results)):
                with self.assertRaises(OSError): module.configure("device", False, Path(directory))

    def test_diagnostic_outputs_are_bounded_and_failed_readback_stays_false(self):
        self.assertEqual(len(module.command_output(b"x" * 8192)), 4096)
        results = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, "unknown 1", "")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=capture_run_port(results)):
                with self.assertRaises(ValueError): module.configure("device", True, output)
            self.assertFalse(json.loads(output.read_text())["readbackMatched"])


    def test_timeout_then_launch_success_records_attempts_before_unchanged_rpc(self):
        results = [subprocess.TimeoutExpired(["notifyutil", "-h"], 5, b"cold", b"pending"),
                   subprocess.CompletedProcess([], 0, "usage", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, module.ENROLLMENT + " 1", "")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=capture_run_port(results)) as run:
                module.configure("device", True, output)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(commands[0], commands[1])
            self.assertEqual(commands[0][-1], "-h")
            self.assertEqual(commands[2][-5:], ["-s", module.ENROLLMENT, "1", "-p", module.ENROLLMENT])
            self.assertEqual(commands[3][-2:], ["-g", module.ENROLLMENT])
            self.assertTrue(all(call.kwargs["timeout"] == 5 for call in run.call_args_list))
            evidence = json.loads(output.read_text())
            self.assertEqual([item.get("attempt") for item in evidence["stages"]], [1, 2, None, None])
            self.assertEqual([item["status"] for item in evidence["stages"]],
                             ["timed_out", "completed", "completed", "completed"])
            self.assertEqual(evidence["stages"][0]["stdout"], "cold")
            self.assertTrue(evidence["readbackMatched"])

    def test_non_timeout_startup_failures_are_never_retried(self):
        for failure in [subprocess.CalledProcessError(17, ["notifyutil"]), OSError(2, "missing fixture tool")]:
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "diagnostics.json"
                with patch.object(module.subprocess, "run", side_effect=capture_run_port([failure])) as run:
                    with self.assertRaises(type(failure)) as caught:
                        module.configure("device", False, output)
                self.assertIs(caught.exception, failure)
                self.assertEqual(run.call_count, 1)
                evidence = json.loads(output.read_text())
                self.assertFalse(evidence["readbackMatched"])
                self.assertEqual(len(evidence["stages"]), 1)
                self.assertEqual(evidence["stages"][0]["attempt"], 1)

    def test_sensor_rpc_timeout_is_never_retried_after_ready_process(self):
        for stage in ["set_and_post", "readback"]:
            ready = subprocess.CompletedProcess([], 0, "usage", "")
            failure = subprocess.TimeoutExpired(["notifyutil"], 5, b"", b"rpc")
            results = [ready, failure] if stage == "set_and_post" else [ready, ready, failure]
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "diagnostics.json"
                with patch.object(module.subprocess, "run", side_effect=capture_run_port(results)) as run:
                    with self.assertRaises(subprocess.TimeoutExpired) as caught:
                        module.configure("device", True, output)
                self.assertIs(caught.exception, failure)
                self.assertEqual(run.call_count, len(results))
                evidence = json.loads(output.read_text())
                self.assertFalse(evidence["readbackMatched"])
                self.assertEqual(evidence["stages"][-1]["stage"], stage)
                self.assertEqual(evidence["stages"][-1]["status"], "timed_out")
                self.assertEqual(evidence["stages"][-1]["timeoutSeconds"], 5)


    def test_real_retained_descendant_pipe_does_not_extend_owned_command_completion(self):
        # The negative uses the original capture transport and the same five seconds.
        with retained_output_parent(self) as (command, children, holder_running):
            with self.assertRaises(subprocess.TimeoutExpired):
                subprocess.run(command, check=True, timeout=5, capture_output=True, text=True)
            self.assertEqual(children[0].poll(), 0)
            self.assertTrue(holder_running())
        # Regular-file capture accepts only the zero-exit owned command while its
        # descendant is demonstrably still holding the inherited stdout/stderr open.
        records = []
        with retained_output_parent(self) as (command, children, holder_running):
            result = module.sensor_command(command, "process_readiness", records)
            self.assertEqual(children[0].poll(), 0)
            self.assertTrue(holder_running())
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "owned command completed\n")
            self.assertEqual(result.stderr, "")
            self.assertEqual(records[0]["status"], "completed")
            self.assertEqual(records[0]["timeoutSeconds"], 5)

    def test_complete_capture_rejects_overflow_instead_of_accepting_readback_prefix(self):
        valid = (module.ENROLLMENT + " 1").encode("utf-8")
        for stdout, stderr in [(valid + b" " * 8192 + b"unexpected", b""),
                               (valid, b"x" * 4097)]:
            records = []
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([
                    subprocess.CompletedProcess([], 0, stdout, stderr)])):
                with self.assertRaises(ValueError):
                    module.sensor_command(["notifyutil"], "readback", records)
            self.assertEqual(records[0]["status"], "capture_failed")
            self.assertLessEqual(len(records[0]["stdout"]), 4096)
            self.assertLessEqual(len(records[0]["stderr"]), 4096)
        results = [subprocess.CompletedProcess([], 0, "usage", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, valid + b" " * 8192 + b"unexpected", b"")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnostics.json"
            with patch.object(module.subprocess, "run", side_effect=capture_run_port(results)) as run:
                with self.assertRaises(ValueError): module.configure("device", True, output)
            self.assertEqual(run.call_count, 3)
            self.assertFalse(json.loads(output.read_text())["readbackMatched"])

    def test_complete_capture_preserves_shared_write_offset_and_exact_limit(self):
        value = "é" * 2048
        with tempfile.TemporaryFile() as capture:
            capture.write(value.encode("utf-8"))
            capture.flush()
            self.assertEqual(capture.tell(), 4096)
            self.assertEqual(module.complete_output(capture), value)
            self.assertEqual(capture.tell(), 4096)
            capture.write(b"unexpected")
            capture.flush()
            with self.assertRaises(ValueError): module.complete_output(capture)

    def test_complete_capture_retains_text_mode_universal_newlines(self):
        with tempfile.TemporaryFile() as capture:
            capture.write(b"first\r\nsecond\rthird\n")
            capture.flush()
            self.assertEqual(module.complete_output(capture), "first\nsecond\nthird\n")

    def test_invalid_utf8_is_not_replaced_in_accepted_command_output(self):
        for stdout, stderr in [(b"invalid \xff", b""), (b"", b"invalid \xff")]:
            records = []
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([
                    subprocess.CompletedProcess([], 0, stdout, stderr)])):
                with self.assertRaises(UnicodeDecodeError):
                    module.sensor_command(["notifyutil"], "readback", records)
            self.assertEqual(records[0]["status"], "capture_failed")

    def test_failed_capture_read_cannot_replace_the_original_command_failure(self):
        for failure in [subprocess.TimeoutExpired(["notifyutil"], 5, b"partial", b"pending"),
                        subprocess.CalledProcessError(17, ["notifyutil"], b"partial", b"failed")]:
            records = []
            with patch.object(module.subprocess, "run", side_effect=capture_run_port([failure])), \
                    patch.object(module.os, "pread", side_effect=OSError(5, "diagnostic read failed")):
                with self.assertRaises(type(failure)) as caught:
                    module.sensor_command(["notifyutil"], "readback", records)
            self.assertIs(caught.exception, failure)
            self.assertEqual(records[0]["stdoutCaptureError"], "OSError")
            self.assertEqual(records[0]["stderrCaptureError"], "OSError")
            self.assertEqual(records[0]["status"],
                             "timed_out" if isinstance(failure, subprocess.TimeoutExpired) else "failed")

    def test_capture_close_error_preserves_failure_and_denies_otherwise_success(self):
        real_capture = module.tempfile.TemporaryFile
        created = []

        class CloseFailure:
            def __init__(self):
                self.capture = real_capture()
                created.append(self.capture)
            def __getattr__(self, name):
                return getattr(self.capture, name)
            def close(self):
                self.capture.close()
                raise OSError(5, "capture close failed")

        failure = subprocess.TimeoutExpired(["notifyutil"], 5)
        records = []
        with patch.object(module.tempfile, "TemporaryFile", side_effect=CloseFailure), \
                patch.object(module.subprocess, "run", side_effect=capture_run_port([failure])):
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                module.sensor_command(["notifyutil"], "readback", records)
        self.assertIs(caught.exception, failure)
        self.assertEqual(records[0]["status"], "timed_out")
        self.assertEqual(records[0]["captureCloseError"], "OSError")
        self.assertTrue(all(capture.closed for capture in created))
        records = []
        with patch.object(module.tempfile, "TemporaryFile", side_effect=CloseFailure), \
                patch.object(module.subprocess, "run", side_effect=capture_run_port([
                    subprocess.CompletedProcess([], 0, "valid", "")])):
            with self.assertRaises(OSError):
                module.sensor_command(["notifyutil"], "readback", records)
        self.assertEqual(records[0]["status"], "capture_failed")
        self.assertTrue(all(capture.closed for capture in created))

    def test_successful_command_with_unreadable_capture_is_not_accepted(self):
        records = []
        with patch.object(module.subprocess, "run", side_effect=capture_run_port([
                subprocess.CompletedProcess([], 0, b"valid", b"")])), \
                patch.object(module.os, "pread", side_effect=OSError(5, "capture read failed")):
            with self.assertRaises(OSError):
                module.sensor_command(["notifyutil"], "readback", records)
        self.assertEqual(records[0]["status"], "capture_failed")

if __name__ == "__main__":
    unittest.main()
