#!/usr/bin/env bash
# What a release tag has to be before anything is built for it (ADR 0207).
#
#   scripts/release/tag-check.sh commit SHA
#   scripts/release/tag-check.sh verify TAG SHA [MAIN_REF]
#
# SHA is a full 40-hex object name, never a ref name. commit prints the commit
# SHA names. GITHUB_SHA on a tag push is the commit for
# a lightweight tag and may be the tag object for an annotated one, so every
# comparison with a commit (is it on main, is it the one the tag names now)
# goes through this peel and never through the raw value.
#
# verify runs in the checkout of the tag and prints that commit when
#   - TAG is v<version> or v<version>-<suffix>, <version> being the
#     [workspace.package] version of Cargo.toml in this checkout,
#   - the commit is an ancestor of MAIN_REF (a full ref, default
#     refs/remotes/origin/main, or HEAD), so a tag on any other commit stops
#     here, before a build minute is spent, and
#   - HEAD is that commit: the tree about to be built is the one checked.
# It exits 2 with a message on stderr otherwise.
#
# Nothing here resolves a bare name. A short ref such as origin/main is read by
# git as a tag of that name before the remote-tracking branch, and the tag job
# fetches every tag, so anyone who can push a tag could plant one that makes any
# commit look like it is on main; the tag and workspace version are only ever
# compared as text.
# .github/workflows/release-kit.yml runs it first; the jobs that build and
# publish need it.
set -euo pipefail

die() { echo "tag-check: $*" >&2; exit 2; }

usage() {
  cat >&2 <<'EOF'
usage: scripts/release/tag-check.sh commit SHA
       scripts/release/tag-check.sh verify TAG SHA [MAIN_REF]
EOF
  exit 2
}

# The commit `$1` names, through any annotated tag object. `$1` has to be a
# full object name: a ref name is looked up by git's own search order.
peel() {
  [[ $1 =~ ^[0-9a-f]{40}$ ]] || die "$1 is not a full 40-hex object name"
  git rev-parse --verify --quiet "${1}^{commit}" || die "$1 is not a commit or a tag of one"
}

# [workspace.package] version, from Cargo.toml in the current directory.
workspace_version() {
  awk '
    /^\[workspace\.package\]/ { inside = 1; next }
    /^\[/ { inside = 0 }
    inside && /^version[ \t]*=/ { gsub(/["[:space:]]/, ""); sub(/^version=/, ""); print; exit }
  ' Cargo.toml
}

cmd_verify() {
  [ $# -ge 2 ] && [ $# -le 3 ] || usage
  local tag=$1 main=${3:-refs/remotes/origin/main} commit version
  [[ $main == refs/* || $main == HEAD ]] || die "$main is not a full ref name (refs/...) or HEAD"
  [[ $tag =~ ^v[0-9][0-9A-Za-z._-]*$ ]] || die "tag $tag is not v<version>"
  commit=$(peel "$2")
  version=$(workspace_version)
  [ -n "$version" ] || die "no [workspace.package] version in Cargo.toml"
  case "${tag#v}" in
    "$version" | "$version"-*) ;;
    *) die "$tag is not version $version (Cargo.toml); set the workspace version first" ;;
  esac
  git rev-parse --verify --quiet "$main^{commit}" >/dev/null || die "no $main to compare with; fetch it first"
  git merge-base --is-ancestor "$commit" "$main" ||
    die "$tag points at $commit, which is not on $main. Tag a commit that main already contains."
  [ "$(git rev-parse HEAD)" = "$commit" ] || die "the checkout is $(git rev-parse HEAD), not $commit"
  echo "$commit"
}

[ $# -ge 1 ] || usage
sub=$1
shift
case $sub in
  commit)
    [ $# -eq 1 ] || usage
    peel "$1"
    ;;
  verify) cmd_verify "$@" ;;
  *) usage ;;
esac
