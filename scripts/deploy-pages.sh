#!/usr/bin/env bash
# deploy-pages.sh — build apps/pages and publish it to the `gh-pages` branch
# without any GitHub Actions involvement.
#
# Usage:
#   scripts/deploy-pages.sh [--dry-run] [--force]
#
# Flags:
#   --dry-run  Build and stage the deploy in a temporary worktree, commit
#              locally, but skip `git push`. Nothing on the remote changes.
#   --force    Skip the "working tree must be clean" guard. Use only when
#              you have deliberately chosen to deploy from a dirty tree
#              (e.g. you already know the untracked files are irrelevant
#              to the build). Off by default; the script refuses otherwise.
#
# Env:
#   PAGES_BASE_PATH  Public base path baked into the built assets by Vite
#                     (`VITE_BASE` in apps/pages/vite.config.ts). Defaults
#                     to "/OpenSesame/" — the correct value for
#                     https://<owner>.github.io/OpenSesame/. Override only
#                     if deploying to a custom domain or different path.
#
# What it does:
#   1. Refuses to run on a dirty working tree (unless --force).
#   2. Builds apps/pages via `pnpm --filter @opensesame/pages build`, with
#      VITE_BASE=$PAGES_BASE_PATH so the built assets reference the right
#      public path.
#   3. Checks out (or creates) the `gh-pages` branch into a temporary
#      `git worktree` at .git/tmp/gh-pages-deploy — no full second clone.
#   4. Mirrors apps/pages/dist/ into that worktree, adds .nojekyll, and
#      commits as `deploy(pages): <short-sha>`.
#   5. Pushes `gh-pages` to `origin` (skipped on --dry-run).
#   6. Removes the temporary worktree.
#
# No step in this script touches .github/ or invokes GitHub Actions in any
# way — this is a plain local/agent-session deploy path, per PRODUCT.md's
# "no custom GitHub Actions runners for deploy" constraint.

set -euo pipefail

DRY_RUN=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      sed -n '2,37p' "$0"
      exit 0
      ;;
    *)
      echo "deploy-pages.sh: unknown argument: $arg" >&2
      echo "usage: deploy-pages.sh [--dry-run] [--force]" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PAGES_BASE_PATH="${PAGES_BASE_PATH:-/OpenSesame/}"
PAGES_DIST="$REPO_ROOT/apps/pages/dist"
WORKTREE_DIR="$REPO_ROOT/.git/tmp/gh-pages-deploy"
BRANCH="gh-pages"
REMOTE="origin"

log() { printf '[deploy-pages] %s\n' "$1"; }

# --- 1. Clean working tree guard ------------------------------------------

if [ "$FORCE" -ne 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "deploy-pages.sh: working tree is not clean." >&2
    echo "Commit, stash, or pass --force to deploy anyway (not recommended)." >&2
    git status --short >&2
    exit 1
  fi
else
  log "skipping clean-tree check (--force)"
fi

SHORT_SHA="$(git rev-parse --short HEAD)"

# --- 2. Build apps/pages with the right base path --------------------------

log "building @opensesame/pages (VITE_BASE=$PAGES_BASE_PATH)"
VITE_BASE="$PAGES_BASE_PATH" pnpm --filter @opensesame/pages build

if [ ! -d "$PAGES_DIST" ]; then
  echo "deploy-pages.sh: build did not produce $PAGES_DIST" >&2
  exit 1
fi

# GitHub Pages has no SPA rewrite. Serving index.html as 404.html makes deep
# links (/sites, /broker/authorize, …) load the app instead of a dead page.
cp "$PAGES_DIST/index.html" "$PAGES_DIST/404.html"

# --- 3. Prepare a temporary worktree checked out onto gh-pages -------------

cleanup_worktree() {
  if [ -d "$WORKTREE_DIR" ]; then
    git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || rm -rf "$WORKTREE_DIR"
  fi
  git worktree prune >/dev/null 2>&1 || true
}
trap cleanup_worktree EXIT

# Leftover worktree from a previous interrupted run — clear it first.
if [ -d "$WORKTREE_DIR" ]; then
  log "removing stale worktree at $WORKTREE_DIR"
  git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || rm -rf "$WORKTREE_DIR"
  git worktree prune >/dev/null 2>&1 || true
fi
mkdir -p "$(dirname "$WORKTREE_DIR")"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  log "checking out existing local branch '$BRANCH' into worktree"
  git worktree add "$WORKTREE_DIR" "$BRANCH"
elif git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  log "fetching existing remote branch '$REMOTE/$BRANCH' into worktree"
  git fetch "$REMOTE" "$BRANCH:$BRANCH"
  git worktree add "$WORKTREE_DIR" "$BRANCH"
else
  log "branch '$BRANCH' does not exist yet; creating an orphan branch"
  git worktree add --detach "$WORKTREE_DIR" HEAD
  (
    cd "$WORKTREE_DIR"
    git checkout --orphan "$BRANCH"
    # Clear everything checked out from HEAD; this branch starts empty.
    git rm -rf --quiet . >/dev/null 2>&1 || true
  )
fi

# --- 4. Mirror dist/ into the worktree, stamp .nojekyll, commit ------------

log "syncing $PAGES_DIST -> $WORKTREE_DIR"
# Clear existing tracked contents (but keep the worktree's own .git file).
find "$WORKTREE_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='.git' "$PAGES_DIST"/ "$WORKTREE_DIR"/
else
  cp -a "$PAGES_DIST"/. "$WORKTREE_DIR"/
fi

# GitHub Pages ignores files/dirs starting with "_" unless this is present.
touch "$WORKTREE_DIR/.nojekyll"

(
  cd "$WORKTREE_DIR"
  git add -A
  if git diff --cached --quiet; then
    log "no changes to publish (dist output identical to current $BRANCH)"
  else
    git commit --quiet -m "deploy(pages): $SHORT_SHA"
    log "committed deploy(pages): $SHORT_SHA"
  fi
)

# --- 5. Push (unless --dry-run) --------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run: skipping 'git push $REMOTE $BRANCH' (build + local commit in the worktree completed; nothing was sent to $REMOTE)"
else
  log "pushing $BRANCH to $REMOTE"
  (
    cd "$WORKTREE_DIR"
    git push "$REMOTE" "$BRANCH"
  )
fi

# --- 6. Print the Pages URL hint --------------------------------------------

ORIGIN_URL="$(git remote get-url "$REMOTE" 2>/dev/null || echo "")"
OWNER=""
if [[ "$ORIGIN_URL" =~ github\.com[:/]+([^/]+)/OpenSesame(\.git)?$ ]]; then
  OWNER="${BASH_REMATCH[1]}"
fi

if [ -n "$OWNER" ]; then
  log "Pages URL: https://${OWNER}.github.io${PAGES_BASE_PATH}"
else
  log "Pages URL: https://<owner>.github.io${PAGES_BASE_PATH} (could not infer owner from '$ORIGIN_URL')"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run complete — nothing was pushed to $REMOTE/$BRANCH"
else
  log "deploy complete"
fi
