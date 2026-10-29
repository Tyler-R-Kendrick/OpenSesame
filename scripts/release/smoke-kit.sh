#!/usr/bin/env bash
# Execute the actual archived kit against the selected source's schema fixture.
# Run from the source checkout. No cargo invocation, dependencies or rebuild.
set -euo pipefail
[ "$#" = 1 ] || { echo 'usage: smoke-kit.sh KIT_ARCHIVE' >&2; exit 2; }
tools=$(cd "$(dirname "$0")" && pwd)
archive=$(realpath "$1")
name=$(basename "$archive" .tar.gz)
[[ "$name" =~ ^opensesame-kit_v([0-9]+\.[0-9]+\.[0-9]+)_(x86_64|aarch64)-unknown-linux-gnu$ ]] || exit 2
version=${BASH_REMATCH[1]}
architecture=${BASH_REMATCH[2]}
[ "$(uname -m)" = "$architecture" ] || { echo 'Kit does not match runner architecture' >&2; exit 1; }
work=$(mktemp -d)
checkout_parser=packages/env-spec-bridge/bin/opensesame-env-parse.mjs
restore() {
  if [ -f "$work/checkout-parser.mjs" ]; then mv "$work/checkout-parser.mjs" "$checkout_parser"; fi
  rm -rf "$work"
}
trap restore EXIT
python3 "$tools/archive-safe.py" tar "$archive" "$work/unpacked"
kit="$work/unpacked/$name"
if [ -f "$checkout_parser" ]; then mv "$checkout_parser" "$work/checkout-parser.mjs"; fi
export OPENSESAME_NODE
OPENSESAME_NODE=$(readlink -f "$(command -v node)")
unset OPENSESAME_ENV_PARSE
[ "$("$kit/opensesame" --version)" = "opensesame $version" ]
"$kit/opensesame" dev --schema tests/fixtures/demo.env.schema check > "$work/check.json"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!s.items.some(i=>i.key==="WORKOS_API_KEY")) process.exit(1)' "$work/check.json"
chmod 0666 "$kit/opensesame-env-parse.mjs"
if "$kit/opensesame" dev --schema tests/fixtures/demo.env.schema check 2> "$work/refused.txt"; then
  echo 'A writable bridge was executed' >&2; exit 1
fi
grep -F 'writable by others' "$work/refused.txt"
