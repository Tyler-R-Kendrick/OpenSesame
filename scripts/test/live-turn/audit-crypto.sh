#!/usr/bin/env bash
# A local module replacement has no version that OSV can query. Verify its exact
# source first, then audit those same packages against the real upstream module.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
GO="${OPENSESAME_GO_BIN:-go}"
python3 "$ROOT/verify-crypto-subset.py"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/third_party/x-crypto/UPSTREAM.json")"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-turn-crypto.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT

# Go verifies the module zip against the checksum database; the verifier also
# checks the pinned checksum, upstream commit and every included source byte.
(cd "$scratch" && "$GO" mod download -json "golang.org/x/crypto@$version") > "$scratch/upstream.json"
python3 "$ROOT/verify-crypto-subset.py" --upstream-metadata "$scratch/upstream.json"

# Exercise the original upstream vectors and optimized/generic implementations.
(cd "$ROOT/third_party/x-crypto" && "$GO" test -mod=readonly ./... && "$GO" test -mod=readonly -tags=purego ./...)

# No replacement or vendored directory is copied: govulncheck sees the actual
# maintained upstream version and reports every advisory in imported packages,
# even when the affected function has no demonstrated call path.
cp "$ROOT/go.mod" "$ROOT/go.sum" "$scratch/"
cp "$ROOT"/*.go "$scratch/"
cd "$scratch"
# Dependency verification does not require a Git checkout or VCS build stamps.
export GOFLAGS="${GOFLAGS:-} -buildvcs=false"
"$GO" mod edit -dropreplace=golang.org/x/crypto
"$GO" mod download
"$GO" mod download "golang.org/x/crypto@$version"
"$GO" list -mod=readonly -deps -test -f '{{.ImportPath}}' ./... > "$scratch/imports.txt"
python3 "$ROOT/verify-crypto-subset.py" --imports "$scratch/imports.txt"
"$GO" run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -scan=package -test ./...
