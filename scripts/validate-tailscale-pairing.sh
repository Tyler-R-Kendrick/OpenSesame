#!/usr/bin/env bash
# validate-tailscale-pairing.sh — prove daemon↔Tailscale Serve pairing prerequisites.
set -euo pipefail
HEALTH_URL="${1:-http://127.0.0.1:18790/health}"

echo "[validate] GET $HEALTH_URL"
json="$(curl -fsS --max-time 5 "$HEALTH_URL")"
python3 - "$json" <<'PY'
import json, sys
h = json.loads(sys.argv[1])
print(json.dumps(h, indent=2))
failed = []

def need(cond, msg):
    global failed
    print(("PASS" if cond else "FAIL"), msg)
    if not cond:
        failed.append(msg)

need(h.get("service") == "opensesame-daemon", "service is opensesame-daemon")
need(bool(h.get("tailscale_cli")), "tailscale CLI resolved (Windows path OK from WSL)")
need(bool(h.get("tailscale_dns")), "tailscale DNS name present")
if h.get("tailscale_serve"):
    need(bool(h.get("tailscale_url")), "tailscale_url set when serve active")
    need(str(h.get("tailscale_url", "")).endswith(".ts.net") or ".ts.net/" in str(h.get("tailscale_url")),
         "tailscale_url is *.ts.net")
    url = str(h.get("tailscale_url") or "").rstrip("/")
    import subprocess, json as _json
    probe = subprocess.run(
        ["curl", "-fsSk", "--connect-timeout", "5", "--max-time", "15", f"{url}/health"],
        capture_output=True, text=True,
    )
    if probe.returncode != 0:
        need(False, f"https Serve /health reachable ({probe.stderr.strip() or probe.stdout.strip() or 'curl failed'})")
    else:
        try:
            remote = _json.loads(probe.stdout)
            need(remote.get("service") == "opensesame-daemon", "https Serve /health returns daemon")
        except Exception as e:
            need(False, f"https Serve /health JSON ({e})")
    print("[validate] Serve is active — paste tailscale_url into github.io")
else:
    need(h.get("tailscale_url") in (None, ""), "tailscale_url null until serve works")
    enable = h.get("tailscale_serve_enable_url") or ""
    need(enable.startswith("https://login.tailscale.com/f/serve?"),
         "tailscale_serve_enable_url present when serve off")
    print("[validate] Open this URL, enable Serve, restart daemon, re-run:")
    print(" ", enable or "(missing)")
raise SystemExit(1 if failed else 0)
PY
