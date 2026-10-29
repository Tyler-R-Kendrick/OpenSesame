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

# Tracked configuration and ignored personal settings may be edited while an
# install is running. Never reset or rewrite them after the install; report
# tracked changes so they can be reviewed instead.
TRACKED=".codex/hooks.json .claude/settings.json skills-lock.json"

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
  while IFS="$(printf '\t')" read -r name source; do
    echo "install-agent-skills: adding $name from $source (latest)"
    timeout --kill-after=15 300 npx -y "$SKILLS_CLI" add "$source" -s "$name" -a claude-code -a grok --full-depth -y </dev/null \
      || degrade "could not install optional skill $name"
  done <<< "$missing"
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

# 5. Do not alter personal hook settings. Impeccable is explicitly invoked
#    with --no-hooks above; other pre-existing registrations belong to their
#    owner and may be changed concurrently while the installers run.

# 6. Container Chromium patch for scandinavian-design verifiers: the tracked
#    repo previously carried this as a patched .claude variant; installed
#    copies are patched in place instead (ignored output, re-applied after
#    every update) and the patch is verified, not assumed. Container-only:
#    outside the container the canonical `channel: 'chrome'` (system Chrome)
#    must stay, or local verifiers would launch a nonexistent executable.
PATCH_OK="true"
if [ -n "${PLAYWRIGHT_CHROMIUM:-}" ] || [ -x /opt/pw-browsers/chromium ]; then
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
fi

# 7. Installers materialize real copies in harness mirrors; collapse them
#    to links without resetting tracked files. A reset would also erase edits
#    made while this long-running script was active.
node scripts/dev/sync-agent-skills.mjs || degrade "skill mirror sync reported problems"
if [ -n "$(git status --porcelain -- $TRACKED 2>/dev/null)" ]; then
  degrade "tracked skill configuration is modified; review changes before committing"
fi

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
