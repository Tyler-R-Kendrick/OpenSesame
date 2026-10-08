#!/usr/bin/env python3
"""Test-runner-only bridge to real simulator sensor commands, never application authority."""
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


ENROLLMENT = "com.apple.BiometricKit.enrollmentChanged"
MATCH = "com.apple.BiometricKit_Sim.pearl.match"


def command_output(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    return (value or "")[:4096]


def complete_output(capture):
    value = os.pread(capture.fileno(), 4097, 0)
    if len(value) > 4096:
        raise ValueError("Simulator command output exceeded its capture bound")
    return value.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def capture_diagnostics(record, stdout, stderr):
    for name, capture in [("stdout", stdout), ("stderr", stderr)]:
        try:
            record[name] = command_output(os.pread(capture.fileno(), 4096, 0))
        except Exception as error:
            record[name] = ""
            record[name + "CaptureError"] = type(error).__name__


def sensor_command(args, stage, diagnostics):
    started = time.monotonic()
    record = {"stage": stage, "timeoutSeconds": 5}
    captures = []
    failed = False
    try:
        stdout = tempfile.TemporaryFile()
        captures.append(stdout)
        stderr = tempfile.TemporaryFile()
        captures.append(stderr)
        try:
            # Wait for the owned command, not EOF from independently retained pipes.
            # subprocess.run kills and waits its owned process on a timeout.
            result = subprocess.run(args, check=True, timeout=5, stdout=stdout, stderr=stderr)
        except subprocess.TimeoutExpired:
            record.update(status="timed_out")
            capture_diagnostics(record, stdout, stderr)
            raise
        except subprocess.CalledProcessError as error:
            record.update(status="failed", exitCode=error.returncode)
            capture_diagnostics(record, stdout, stderr)
            raise
        except OSError as error:
            record.update(status="launch_failed", errno=error.errno)
            raise
        try:
            output = complete_output(stdout)
            error_output = complete_output(stderr)
        except (OSError, ValueError) as error:
            record.update(status="capture_failed", captureError=type(error).__name__)
            capture_diagnostics(record, stdout, stderr)
            raise
        record.update(status="completed", exitCode=result.returncode,
                      stdout=command_output(output), stderr=command_output(error_output))
        return subprocess.CompletedProcess(result.args, result.returncode, output, error_output)
    except BaseException:
        failed = True
        if "status" not in record:
            record["status"] = "capture_failed"
        raise
    finally:
        close_error = None
        for capture in captures:
            try:
                capture.close()
            except OSError as error:
                record["captureCloseError"] = type(error).__name__
                close_error = error
        record["elapsedSeconds"] = round(time.monotonic() - started, 6)
        diagnostics.append(record)
        if close_error is not None and not failed:
            record["status"] = "capture_failed"
            raise close_error


def set_enrollment(device, enabled, diagnostics=None):
    if diagnostics is None:
        diagnostics = []
    value = "1" if enabled else "0"
    prefix = ["xcrun", "simctl", "spawn", device, "notifyutil"]
    sensor_command(prefix + ["-s", ENROLLMENT, value, "-p", ENROLLMENT], "set_and_post", diagnostics)
    result = sensor_command(prefix + ["-g", ENROLLMENT], "readback", diagnostics)
    fields = result.stdout.strip().split()
    if fields not in [[ENROLLMENT, value], [ENROLLMENT, "=", value]]:
        raise ValueError("Simulator enrollment state did not match its required OS fixture")


def process_readiness(device, diagnostics):
    # Cold simulator process launch has a separate bounded initialization budget.
    # Only timeouts retry; sensor mutation/readback below never retries.
    for attempt in range(1, 4):
        try:
            sensor_command(["xcrun", "simctl", "spawn", device, "notifyutil", "-h"],
                           "process_readiness", diagnostics)
            return
        except subprocess.TimeoutExpired:
            if attempt == 3:
                raise
        finally:
            diagnostics[-1]["attempt"] = attempt


def configure(device, enabled, output=None):
    diagnostics = {"v": 1, "scope": "Simulator sensor bootstrap; not app admission", "stages": []}
    failed = False
    try:
        # -h exits before libnotify registration/RPC. This proves the actual
        # simulator process launched, independently of notification-broker state.
        process_readiness(device, diagnostics["stages"])
        set_enrollment(device, enabled, diagnostics["stages"])
        diagnostics["readbackMatched"] = True
    except BaseException:
        failed = True
        diagnostics["readbackMatched"] = False
        raise
    finally:
        if output is not None:
            try:
                output.write_text(json.dumps(diagnostics, sort_keys=True) + "\n")
            except OSError:
                if not failed:
                    raise
                print("Sensor diagnostic preservation failed; original failure retained", file=sys.stderr)


def main():
    device = str(uuid.UUID(sys.argv[2]))
    if sys.argv[1] == "configure":
        if sys.argv[3] not in ["0", "1"]:
            raise ValueError("unsupported enrollment state")
        output = Path(sys.argv[4]) if len(sys.argv) == 5 else None
        configure(device, sys.argv[3] == "1", output)
        return
    if sys.argv[1] != "serve":
        raise ValueError("unsupported sensor fixture command")
    port_file = Path(sys.argv[3])
    calls = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format, *args):
            pass  # No request bodies, credentials or application state in fixture logs.

        def do_POST(self):
            nonlocal calls
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if self.path != "/match" or not 0 < size <= 64 or calls >= 32:
                    raise ValueError("unsupported sensor action")
                if json.loads(self.rfile.read(size)) != {"v": 1, "action": "match"}:
                    raise ValueError("unsupported sensor payload")
                calls += 1
                matched = False
                # Only a deliberate UI operation requests this bounded sensor sequence. Some
                # operations derive their password before displaying LAContext's real prompt.
                for _ in range(8):
                    time.sleep(0.5)
                    result = subprocess.run(["xcrun", "simctl", "spawn", device, "notifyutil", "-p", MATCH],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            timeout=1, check=False)
                    matched = matched or result.returncode == 0
                status = 200 if matched else 503
                response = json.dumps({"matched": matched}).encode()
            except (ValueError, json.JSONDecodeError, subprocess.TimeoutExpired):
                status, response = 400, b'{"matched":false}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port_file.write_text(str(server.server_address[1]))
    server.serve_forever()


if __name__ == "__main__":
    main()
