#!/usr/bin/env bash
# SessionStart is inert unless dependency bootstrap is explicitly requested.
# Database code generation belongs to deliberate schema changes, never session start.
set -euo pipefail

# This sandbox's inherited NODE_OPTIONS can be poisoned (e.g. a malformed
# "--import tsx" flag combo) which makes plain node/pnpm/corepack invocations
# fail outright. Unset it defensively so a broken inherited env var can never
# silently break this hook.
unset NODE_OPTIONS

# A remote-session flag identifies the harness; it does not request an install.
if [ "${OPENSESAME_AGENT_BOOTSTRAP:-}" != "1" ]; then
  echo "[session-start] bootstrap skipped (set OPENSESAME_AGENT_BOOTSTRAP=1 to install dependencies)" >&2
  exit 0
fi

# --- Trust gate #2: production-credential refusal -----------------------
# A repo-controlled hook runs before a human has necessarily reviewed the
# checkout. Even if gate #1 passed, refuse outright if the environment looks
# like it holds production credentials.
if [ "${OPENSESAME_ENV:-}" = "production" ] \
   || [ -n "${OPENSESAME_CLAIM_PEPPER:-}" ] \
   || [ -n "${OPENSESAME_AUTH_SECRET:-}" ]; then
  echo "[session-start] refusing automated bootstrap: production-shaped credentials are present in this environment" >&2
  exit 0
fi

# Reuse the installed dependency tree until the tracked inputs change.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash "$ROOT/scripts/dev/install-dependencies.sh"
echo "[session-start] dependency bootstrap complete"
