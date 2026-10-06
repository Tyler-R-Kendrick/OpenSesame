#!/usr/bin/env python3
"""Test-runner-only bridge to real simulator sensor commands, never application authority."""
import json
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


ENROLLMENT = "com.apple.BiometricKit.enrollmentChanged"
MATCH = "com.apple.BiometricKit_Sim.pearl.match"


def set_enrollment(device, enabled):
    value = "1" if enabled else "0"
    prefix = ["xcrun", "simctl", "spawn", device, "notifyutil"]
    subprocess.run(prefix + ["-s", ENROLLMENT, value, "-p", ENROLLMENT], check=True, timeout=5)
    result = subprocess.run(prefix + ["-g", ENROLLMENT], check=True, timeout=5, capture_output=True, text=True)
    fields = result.stdout.strip().split()
    if fields not in [[ENROLLMENT, value], [ENROLLMENT, "=", value]]:
        raise ValueError("Simulator enrollment state did not match its required OS fixture")


def main():
    device = str(uuid.UUID(sys.argv[2]))
    if sys.argv[1] == "configure":
        if sys.argv[3] not in ["0", "1"]:
            raise ValueError("unsupported enrollment state")
        set_enrollment(device, sys.argv[3] == "1")
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
