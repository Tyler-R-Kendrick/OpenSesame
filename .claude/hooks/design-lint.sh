#!/usr/bin/env bash
# Hold agent edits to the control contract (docs/design/controls.md) as they
# happen, rather than at review time — which is when it was caught the once.
#
# Reads the hook payload on stdin, lints only the file that was just written,
# and stays silent unless something is wrong. Never blocks on anything it does
# not own: a non-UI edit exits 0 without running node at all.
set -euo pipefail

# An inherited NODE_OPTIONS with `--import` makes every node call fail; the
# pre-commit hook clears it for the same reason.
unset NODE_OPTIONS

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
payload="$(cat || true)"

# `.tool_input.file_path` without depending on jq being installed.
file="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

case "$file" in
  *.tsx|*.css) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

cd "$ROOT"
node scripts/design-lint.mjs "$file" >/dev/null 2>/tmp/design-lint.$$ && exit 0

echo "Design lint — the control contract (docs/design/controls.md):" >&2
cat /tmp/design-lint.$$ >&2
rm -f /tmp/design-lint.$$
exit 2
