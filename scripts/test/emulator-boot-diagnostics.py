#!/usr/bin/env python3
"""Observe emulator bootstrap only; a diagnostic result never proves app tests."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

SECONDS = 600
SERIAL = "emulator-5554"
FILTERS = ["*:S", "SystemServer:W", "InputManager:W", "InputDispatcher:W", "AndroidRuntime:W"]


class Stopped(Exception):
    pass


def evidence_dir(value):
    directory = Path(value).resolve(strict=True)
    mode = directory.stat()
    if Path(value).is_symlink() or not stat.S_ISDIR(mode.st_mode):
        raise ValueError("Private diagnostic directory required")
    if mode.st_uid != os.getuid() or stat.S_IMODE(mode.st_mode) != 0o700:
        raise ValueError("Owner-only diagnostic directory required")
    return directory


def write(directory, name, value):
    temporary = directory / (name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(directory / name)


def identity(pid):
    try:
        # Fields after comm's closing parenthesis start at field three.
        data = Path(f"/proc/{pid}/stat").read_text()
        return data[data.rfind(")") + 2:].split()[19]
    except FileNotFoundError:
        return None


def start(directory):
    (directory / "collector-owned").mkdir()
    write(directory, "scope.json", {
        "scope": "Emulator bootstrap diagnostics only; feature assertions not executed by this collector",
        "serial": SERIAL, "maximumSeconds": SECONDS, "filters": FILTERS,
    })
    with (directory / "collector.stdout").open("xb") as stdout, (directory / "collector.stderr").open("xb") as stderr:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "collect", str(directory)],
            stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            close_fds=True, start_new_session=True,
        )
    write(directory, "collector-pid.json", {"pid": process.pid, "startTicks": identity(process.pid)})


def reap(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    else:
        process.wait()


def collect(directory):
    def interrupted(_signal, _frame):
        raise Stopped()

    signal.signal(signal.SIGTERM, interrupted)
    deadline = time.monotonic() + SECONDS
    adb = str(Path(os.environ["ANDROID_HOME"]) / "platform-tools/adb")
    process = None
    status, exit_code = "failed", 1
    try:
        with (directory / "boot.log").open("xb") as output:
            commands = [
                ("device-wait", [adb, "-s", SERIAL, "wait-for-device"]),
                ("input-service-log", [adb, "-s", SERIAL, "logcat", "-v", "threadtime", *FILTERS]),
            ]
            for name, command in commands:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=output, close_fds=True, start_new_session=True)
                exit_code = process.wait(timeout=max(0, deadline - time.monotonic()))
                write(directory, name + ".exit.json", {"exit": exit_code})
                if exit_code:
                    break
            status = "completed" if exit_code == 0 else "failed"
    except Stopped:
        status, exit_code = "stopped", 0
    except subprocess.TimeoutExpired:
        status, exit_code = "bounded-collection-ended", 124
    finally:
        if process is not None:
            reap(process)
        write(directory, "collector-result.json", {"status": status, "exit": exit_code, "childrenReaped": True, "featureAssertionsExecuted": False})
    return exit_code


def stop(directory):
    pid_file = directory / "collector-pid.json"
    if not pid_file.exists():
        write(directory, "collector-result.json", {"status": "not-started", "featureAssertionsExecuted": False})
        return 0
    recorded = json.loads(pid_file.read_text())
    current = identity(recorded["pid"])
    if current is not None:
        if current != recorded["startTicks"]:
            raise ValueError("Diagnostic process identity changed")
        try:
            descriptor = os.pidfd_open(recorded["pid"])
        except ProcessLookupError:
            descriptor = None
        if descriptor is not None:
            try:
                if identity(recorded["pid"]) != recorded["startTicks"]:
                    raise ValueError("Diagnostic process identity changed")
                signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            finally:
                os.close(descriptor)
    deadline = time.monotonic() + 10
    result = directory / "collector-result.json"
    while not result.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if not result.exists():
        raise ValueError("Diagnostic collector did not finish cleanup")
    record = json.loads(result.read_text())
    if not record.get("childrenReaped"):
        raise ValueError("Diagnostic child cleanup not confirmed")
    return 0 if record["status"] in ["stopped", "completed", "bounded-collection-ended"] else record["exit"]


def main():
    os.umask(0o077)
    if len(sys.argv) != 3 or sys.argv[1] not in ["start", "collect", "stop"]:
        raise ValueError("Usage: emulator-boot-diagnostics.py start|collect|stop PRIVATE_DIRECTORY")
    directory = evidence_dir(sys.argv[2])
    return {"start": start, "collect": collect, "stop": stop}[sys.argv[1]](directory) or 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError):
        print("Emulator diagnostic setup or cleanup failed; app test result is unchanged.", file=sys.stderr)
        sys.exit(1)
