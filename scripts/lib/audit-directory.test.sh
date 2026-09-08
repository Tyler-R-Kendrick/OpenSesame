#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/audit-directory.sh"
fixture="$(mktemp -d /tmp/opensesame-audit-test.XXXXXXXX)"
mkdir -m 700 "$fixture/checkout" "$fixture/private"
ROOT="$fixture/checkout"
first="$(OPENSESAME_AUDIT_DIR="$fixture/private"; opensesame_audit_directory; printf %s "$OPENSESAME_AUDIT_DIR")"
second="$(OPENSESAME_AUDIT_DIR="$fixture/private"; opensesame_audit_directory; printf %s "$OPENSESAME_AUDIT_DIR")"
[[ "$first" != "$second" && "$(stat -c %a "$first")" == 700 ]]
if (OPENSESAME_AUDIT_DIR="$ROOT"; opensesame_audit_directory); then exit 1; fi
if (OPENSESAME_AUDIT_DIR="$ROOT/reports"; opensesame_audit_directory); then exit 1; fi
if (OPENSESAME_AUDIT_DIR="relative"; opensesame_audit_directory); then exit 1; fi
ln -s "$fixture/private" "$fixture/link"
if (OPENSESAME_AUDIT_DIR="$fixture/link"; opensesame_audit_directory); then exit 1; fi
mkdir -m 755 "$fixture/public"
if (OPENSESAME_AUDIT_DIR="$fixture/public"; opensesame_audit_directory); then exit 1; fi
[[ ! -e "$ROOT/reports" ]]
if (unset OPENSESAME_AUDIT_DIR; TMPDIR="$ROOT"; opensesame_audit_directory); then exit 1; fi
[[ "$(OPENSESAME_AUDIT_DIR="$fixture/private"; opensesame_audit_directory; umask)" == 0077 ]]
printf 'audit-directory tests passed; private fixtures retained at %s\n' "$fixture"
