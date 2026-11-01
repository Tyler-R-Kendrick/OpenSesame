#!/usr/bin/env bash
# Print the Grok Build model id for headless coding. Baseline grok-4.7; if
# `grok models` lists a newer grok-* id, use that. Never prints secrets.
set -euo pipefail

baseline="${GROK_BUILD_MODEL_BASELINE:-grok-4.7}"

best="$baseline"
if command -v grok >/dev/null 2>&1; then
  list_file="$(mktemp)"
  trap 'rm -f "$list_file"' EXIT
  if scripts/dev/grok-headless.sh models >"$list_file" 2>/dev/null; then
    picked="$(
      python3 - "$baseline" "$list_file" <<'PY'
import re
import sys

baseline = sys.argv[1]
path = sys.argv[2]

def parse(ver: str) -> tuple[int, ...]:
    parts = ver.removeprefix("grok-").split(".")
    out: list[int] = []
    for part in parts:
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        out.append(int(digits or "0"))
    return tuple(out)

base = parse(baseline)
ids: list[str] = []
with open(path, encoding="utf-8") as handle:
    for line in handle:
        match = re.search(r"\b(grok-[0-9][^\s]*)\b", line)
        if match:
            ids.append(match.group(1))

eligible = [baseline] + [i for i in ids if parse(i) > base]
if not eligible:
    print(baseline)
else:
    print(max(eligible, key=parse))
PY
    )"
    if [[ -n "$picked" ]]; then
      best="$picked"
    fi
  fi
fi

printf '%s\n' "$best"
