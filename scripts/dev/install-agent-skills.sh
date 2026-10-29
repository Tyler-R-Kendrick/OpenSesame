#!/usr/bin/env bash
# Install/refresh third-party agent skills into .agents/skills/ (+ mirrors).
#
# These skills are install output, not source: .gitignore covers every
# harness root except the repo-built adapters whitelisted there, and the
# third-party trees were removed from source control. skills-lock.json is
# the catalogue (which skills, from which sources); skill CONTENT floats
# to upstream latest on every run (unpinned by design for optional
# profiles), while the installer CLIs below are version-pinned — bump
# them deliberately. Tiers live in skills/profiles.json. First-party
# skills in skills/ are tracked source and need no install; core
# validation passes without any of this.
#
# Runs on every devcontainer start (postStartCommand, which also covers
# first creation) and via `pnpm skills:install`. Safe to re-run; a lock
# file (override: OPENSESAME_SKILLS_LOCK_FILE) serializes concurrent
# runs. Per-skill failures warn and continue (optional profiles may be
# absent, e.g. offline); the outcome is recorded in
# .agents/.skills-currency.json instead of failing container start.
set -uo pipefail

# Pinned installer tool versions (skill content still floats to latest).
SKILLS_CLI="skills@1.7.4"
IMPECCABLE_CLI="impeccable@4.8.0"
TYPEUI_CLI="typeui.sh@0.7.1"

cd "$(dirname "$0")/../.." || exit 1
warn() { echo "install-agent-skills: WARN: $*" >&2; }
STATUS="ok"
degrade() { STATUS="degraded"; warn "$*"; }

# Serialize concurrent runs (postStart + manual) when flock is available.
mkdir -p .agents
LOCK_FILE="${OPENSESAME_SKILLS_LOCK_FILE:-.agents/.skills-install.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -w 120 9; then
    warn "another skills install is running; skipping this run"
    exit 0
  fi
fi

# Snapshot which tracked adapter/lock files are already dirty, so the
# restore at the end only touches installer side effects, never local work.
TRACKED=".codex/hooks.json .claude/settings.json skills-lock.json"
DIRTY_BEFORE=$(git status --porcelain -- $TRACKED 2>/dev/null | cut -c4- | sort || true)

# 1. Install missing catalogue skills at upstream latest
#    (lock key stitch::x installs as stitch-x/). Explicit agents only:
#    '*' also writes Universal (./skills/) and OpenClaw (./agent/) roots
#    this repo does not use. Codex, Copilot, OpenCode, and Gemini
#    discover .agents/skills natively; Claude Code and Grok need mirrors.
if ! missing=$(node -e "
  const fs = require('fs');
  const lock = JSON.parse(fs.readFileSync('skills-lock.json', 'utf8'));
  for (const [name, meta] of Object.entries(lock.skills)) {
    const dir = name.replace('stitch::', 'stitch-');
    if (!fs.existsSync('.agents/skills/' + dir + '/SKILL.md'))
      console.log(name + '\t' + meta.source);
  }
"); then
  degrade "could not read skills-lock.json; skipping catalogue install"
  missing=""
fi
if [ -n "$missing" ]; then
  printf '%s\n' "$missing" | while IFS="$(printf '\t')" read -r name source; do
    echo "install-agent-skills: adding $name from $source (latest)"
    timeout --kill-after=15 300 npx -y "$SKILLS_CLI" add "$source" -s "$name" -a claude-code -a grok --full-depth -y </dev/null \
      || warn "could not install optional skill $name"
  done
fi

# 2. Refresh everything already installed to upstream latest.
timeout --kill-after=15 600 npx -y "$SKILLS_CLI" update -y </dev/null \
  || degrade "skills update failed (offline?); keeping installed versions"

# 3. impeccable ships its own installer/updater (not in skills-lock.json).
#    Restricted providers + no hooks: hook registration belongs to tracked
#    config (.codex/hooks.json, .claude/settings.json), never to an
#    installer's ignored side effects.
if [ -f .agents/skills/impeccable/SKILL.md ]; then
  timeout --kill-after=15 600 npx -y "$IMPECCABLE_CLI" update -y --project --no-hooks </dev/null \
    || degrade "could not update optional skill impeccable"
else
  timeout --kill-after=15 600 npx -y "$IMPECCABLE_CLI" install -y --project --no-hooks --providers=claude,agents,grok </dev/null \
    || degrade "could not install optional skill impeccable"
fi

# 4. design-system is a TypeUI pull (not in skills-lock.json); re-pull latest.
timeout --kill-after=15 300 npx -y "$TYPEUI_CLI" pull minimal -f skill -p claude-code </dev/null \
  || degrade "could not refresh optional skill design-system"
if [ ! -f .agents/skills/design-system/SKILL.md ] && [ -f .claude/skills/design-system/SKILL.md ]; then
  mkdir -p .agents/skills/design-system
  cp -r .claude/skills/design-system/. .agents/skills/design-system/
fi

# 5. Remove hook registrations installers wrote into ignored roots
#    (older host installs, other tools). Only untracked files whose
#    content is an impeccable hook manifest are touched.
for f in .cursor/hooks.json .grok/hooks/impeccable.json .github/hooks/impeccable.json; do
  if [ -f "$f" ] && grep -qi impeccable "$f" && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    rm -f "$f"
    echo "install-agent-skills: removed installer-written hook manifest $f"
  fi
done
if [ -f .claude/settings.local.json ] && ! git ls-files --error-unmatch .claude/settings.local.json >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const path = '.claude/settings.local.json';
    try {
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      let changed = false;
      for (const [event, groups] of Object.entries(data.hooks ?? {})) {
        data.hooks[event] = (groups ?? []).filter((g) => {
          const keep = !(g.hooks ?? []).some((h) => /impeccable/u.test(h.command ?? ''));
          if (!keep) changed = true;
          return keep;
        });
        if (!data.hooks[event].length) delete data.hooks[event];
      }
      if (changed) {
        if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
        fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
        console.log('install-agent-skills: stripped impeccable hooks from ' + path);
      }
    } catch { /* unparseable user settings: leave untouched */ }
  " || true
fi

# 6. Container Chromium patch for scandinavian-design verifiers: the tracked
#    repo previously carried this as a patched .claude variant; installed
#    copies are patched in place instead (ignored output, re-applied after
#    every update) and the patch is verified, not assumed.
PATCH_OK="true"
for f in .agents/skills/scandinavian-design/scripts/density.js \
         .agents/skills/scandinavian-design/scripts/lines.js \
         .agents/skills/scandinavian-design/scripts/tints.js; do
  if [ -f "$f" ]; then
    perl -pi -e "s/channel: 'chrome',/executablePath: process.env.PLAYWRIGHT_CHROMIUM || '\/opt\/pw-browsers\/chromium',/" "$f"
    if grep -q "channel: 'chrome'," "$f"; then
      PATCH_OK="false"
      degrade "scandinavian-design Chromium patch did not apply to $f (upstream format changed?)"
    fi
  fi
done

# 7. Installers materialize real copies in harness mirrors; collapse them
#    to links (this also removes stale mirrors of uninstalled optional
#    skills). Then restore tracked adapters/lock that installers rewrite —
#    but only files that were clean before this run; pre-existing local
#    edits are left alone. Installed content floats to latest; tracked
#    files change only in reviewed commits.
node scripts/dev/sync-agent-skills.mjs || degrade "skill mirror sync reported problems"
for f in $TRACKED; do
  if printf '%s\n' "$DIRTY_BEFORE" | grep -qx "$f"; then
    warn "leaving locally modified $f untouched (installer changes not reverted)"
  else
    git checkout -- "$f" 2>/dev/null || true
  fi
done

# 8. Record currency durably, then gate. A failed check degrades the run
#    (recorded + warned) instead of failing container start; CI gates the
#    fresh tracked tree separately.
if ! node scripts/dev/sync-agent-skills.mjs --check; then
  degrade "sync --check failed after install (see above)"
fi
node -e "
  const fs = require('fs');
  const root = '.agents/skills';
  const installed = fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => fs.existsSync(root + '/' + n + '/SKILL.md')).sort()
    : [];
  fs.writeFileSync('.agents/.skills-currency.json', JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    status: '$STATUS',
    method: 'skills add/update (latest, unpinned) + impeccable + typeui',
    scandinavianPatch: $PATCH_OK,
    installed,
  }, null, 2) + '\n');
" || warn "could not write .agents/.skills-currency.json"
echo "install-agent-skills: done (status: $STATUS)"
