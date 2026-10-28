#!/usr/bin/env bash
# Pack the release kit, and the checksum file over it.
#
#   export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"   # the tagged commit's time
#   scripts/release/kit-archive.sh pack TAG TARGET BIN_DIR BRIDGE OUTDIR
#   scripts/release/kit-archive.sh sums DIR
#
# BIN_DIR holds three executables built from one commit for TARGET:
#   opensesame                                          shipped features
#   opensesame-surrogate-proxy                          shipped features
#   opensesame-surrogate-proxy-TEST-upstream-override   --features upstream-override
# BRIDGE is the bundled env-spec bridge (`node packages/env-spec-bridge/scripts/bundle.mjs`).
#
# pack writes two archives to OUTDIR, each holding one directory of its own name:
#   opensesame-kit_<TAG>_<TARGET>.tar.gz
#     LICENSE, opensesame, opensesame-env-parse.mjs, opensesame-surrogate-proxy
#   opensesame-surrogate-proxy-TEST-upstream-override_<TAG>_<TARGET>.tar.gz
#     LICENSE, opensesame-surrogate-proxy-TEST-upstream-override
# The bridge sits beside `opensesame`, which looks for it there. The test build
# is a separate archive under a name that says what it is, and pack refuses to
# write either archive unless the bytes agree with the names: the shipped plugin
# and `opensesame` must not carry the override's variable
# (crates/surrogate-proxy/tests/shipped_build.rs) and the test build must.
# sums writes DIR/SHA256SUMS over the archives and opensesame-env-parse.mjs in DIR,
# after checking that every kit archive holds exactly that bridge.
#
# The same inputs give the same bytes: members sorted by name, every mtime
# SOURCE_DATE_EPOCH, owner and group 0 with no names, ustar headers (no pax
# timestamps), modes 0755 for the directory and the executables and 0644 for
# LICENSE and the bridge (it is run by node, never executed),
# and gzip -n (no name or time in its header). SOURCE_DATE_EPOCH is required,
# not guessed. GNU tar, gzip and coreutils are required.
# .github/workflows/release-kit.yml runs pack once per target and sums once;
# docs/operators/release-kit.md says how to verify what it publishes.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LICENSE_FILE=${OPENSESAME_RELEASE_LICENSE:-$ROOT/LICENSE}
TAG_RE='^v[0-9][0-9A-Za-z._-]*$'
TARGET_RE='^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(-[a-z0-9_]+)?$'
TEST_BUILD=opensesame-surrogate-proxy-TEST-upstream-override
# The variable only the upstream-override build reads.
MARKER=OPENSESAME_SURROGATE_TEST_UPSTREAM
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die() { echo "kit-archive: $*" >&2; exit 2; }

usage() {
  cat >&2 <<'EOF'
usage: SOURCE_DATE_EPOCH=<unix time> scripts/release/kit-archive.sh
         pack TAG TARGET BIN_DIR BRIDGE OUTDIR
         sums DIR
EOF
  exit 2
}

has_marker() { LC_ALL=C grep -qaF "$MARKER" "$1"; }

# A directory holding each MODE:PATH given, as that mode whatever the file's
# own (an artifact download drops execute bits), packed as <name>.tar.gz in `out`.
archive() {
  local name=$1 out=$2
  shift 2
  local stage=$WORK/$name item
  mkdir -p "$stage"
  chmod 0755 "$stage"
  for item in "$@"; do
    cp "${item#*:}" "$stage/"
    chmod "${item%%:*}" "$stage/$(basename "${item#*:}")"
  done
  (cd "$WORK" && LC_ALL=C tar --format=ustar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" \
    --owner=0 --group=0 --numeric-owner -cf - "$name") | gzip -n -9 > "$out/$name.tar.gz"
  (cd "$out" && sha256sum "$name.tar.gz")
}

cmd_pack() {
  [ $# -eq 5 ] || usage
  local tag=$1 target=$2 bins=$3 bridge=$4 out
  [[ $tag =~ $TAG_RE ]] || die "tag $tag does not match $TAG_RE"
  [[ $target =~ $TARGET_RE ]] || die "target $target is not a target triple"
  [[ ${SOURCE_DATE_EPOCH:-} =~ ^[0-9]+$ ]] || die "SOURCE_DATE_EPOCH must be a Unix time, e.g. \$(git log -1 --format=%ct)"
  local name
  for name in opensesame opensesame-surrogate-proxy "$TEST_BUILD"; do
    [ -f "$bins/$name" ] || die "no file $bins/$name"
  done
  [ -f "$bridge" ] || die "no bridge at $bridge"
  [ "$(basename "$bridge")" = opensesame-env-parse.mjs ] || die "the bridge must be named opensesame-env-parse.mjs, not $(basename "$bridge")"
  has_marker "$bins/$TEST_BUILD" || die "$bins/$TEST_BUILD has no $MARKER: it is not the upstream-override build"
  for name in opensesame opensesame-surrogate-proxy; do
    if has_marker "$bins/$name"; then die "$bins/$name carries $MARKER: a test build is not shipped"; fi
  done
  mkdir -p "$5"
  out=$(cd "$5" && pwd)
  archive "opensesame-kit_${tag}_${target}" "$out" "0644:$LICENSE_FILE" \
    "0755:$bins/opensesame" "0644:$bridge" "0755:$bins/opensesame-surrogate-proxy"
  archive "${TEST_BUILD}_${tag}_${target}" "$out" "0644:$LICENSE_FILE" "0755:$bins/$TEST_BUILD"
}

cmd_sums() {
  [ $# -eq 1 ] || usage
  [ -d "$1" ] || die "no such directory: $1"
  cd "$1"
  shopt -s nullglob
  local kits=(opensesame-kit_*.tar.gz) tests=("${TEST_BUILD}"_*.tar.gz)
  [ ${#kits[@]} -gt 0 ] || die "no opensesame-kit_*.tar.gz in $1"
  [ ${#tests[@]} -eq ${#kits[@]} ] || die "${#kits[@]} kit archive(s) but ${#tests[@]} test-build archive(s) in $1"
  [ -f opensesame-env-parse.mjs ] || die "no opensesame-env-parse.mjs in $1"
  # The bridge on its own is the one in every kit: same bytes, checked, not assumed.
  local want got kit
  want=$(sha256sum < opensesame-env-parse.mjs | cut -d' ' -f1)
  for kit in "${kits[@]}"; do
    got=$(tar -xzOf "$kit" "${kit%.tar.gz}/opensesame-env-parse.mjs" | sha256sum | cut -d' ' -f1) ||
      die "cannot read opensesame-env-parse.mjs from $kit"
    [ "$got" = "$want" ] || die "$kit holds an opensesame-env-parse.mjs ($got) that is not the one on its own ($want)"
  done
  local files=("${kits[@]}" "${tests[@]}" opensesame-env-parse.mjs)
  printf '%s\n' "${files[@]}" | LC_ALL=C sort | xargs -d '\n' sha256sum > SHA256SUMS
  sha256sum --check --quiet SHA256SUMS
  cat SHA256SUMS
}

[ $# -ge 1 ] || usage
sub=$1
shift
case $sub in
  pack) cmd_pack "$@" ;;
  sums) cmd_sums "$@" ;;
  *) usage ;;
esac
