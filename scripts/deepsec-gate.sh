#!/usr/bin/env bash
# Deepsec gate: pattern scan (+ optional AI process when credentials allow).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WS="${ROOT}/.deepsec"
cd "$ROOT"

if [[ ! -d "$WS" ]]; then
  echo "deepsec-gate: missing .deepsec/ — run: npx deepsec init --scaffold-only" >&2
  exit 1
fi

if [[ ! -d "$WS/node_modules/deepsec" ]]; then
  echo "==> deepsec-gate: installing workspace deps"
  (cd "$WS" && pnpm install)
fi

echo "==> deepsec-gate: pattern scan (free, no AI)"
(cd "$WS" && pnpm deepsec scan --project-id opensesame)

echo "==> deepsec-gate: candidate summary"
python3 - <<PY
import json, collections, os
root = "${ROOT}/.deepsec/data/opensesame/files"
by = collections.Counter()
files = 0
for dp, _, fns in os.walk(root):
    for fn in fns:
        if not fn.endswith(".json"):
            continue
        files += 1
        data = json.load(open(os.path.join(dp, fn)))
        for c in data.get("candidates") or []:
            slug = c.get("vulnSlug")
            if slug:
                by[slug] += 1
print(f"files_with_state={files} total_hits={sum(by.values())}")
for slug, n in by.most_common(15):
    print(f"  {n:4d}  {slug}")
PY

if [[ "${DEEPSEC_PROCESS:-0}" == "1" ]]; then
  echo "==> deepsec-gate: AI process (DEEPSEC_PROCESS=1)"
  (
    cd "$WS"
    if [[ -f .env.local ]] && grep -q VERCEL_OIDC_TOKEN .env.local; then
      limit_args=()
      if [[ -n "${DEEPSEC_LIMIT:-}" && "${DEEPSEC_LIMIT}" != "0" ]]; then
        limit_args=(--limit "${DEEPSEC_LIMIT}")
      fi
      filter_args=()
      if [[ -n "${DEEPSEC_FILTER:-}" ]]; then
        filter_args=(--filter "${DEEPSEC_FILTER}")
      fi
      pnpm deepsec process --project-id opensesame \
        --agent pi --model "${DEEPSEC_MODEL:-zai/glm-5.2}" \
        --thinking-level "${DEEPSEC_THINKING:-medium}" \
        --concurrency "${DEEPSEC_CONCURRENCY:-2}" \
        "${limit_args[@]}" \
        "${filter_args[@]}"
    else
      pnpm deepsec process --project-id opensesame \
        --agent "${DEEPSEC_AGENT:-codex}" \
        --model "${DEEPSEC_MODEL:-zai/glm-5.2}" \
        --thinking-level "${DEEPSEC_THINKING:-medium}" \
        --concurrency "${DEEPSEC_CONCURRENCY:-2}"
    fi
    pnpm deepsec export --project-id opensesame --format md-dir --out ./findings
  )
else
  echo "==> deepsec-gate: skipping AI process (set DEEPSEC_PROCESS=1 after topping up AI Gateway / clearing rate limits)"
fi

echo "==> deepsec-gate: status"
(cd "$WS" && pnpm deepsec status --project-id opensesame) || true
echo
echo "deepsec-gate: OK (scan complete)"
