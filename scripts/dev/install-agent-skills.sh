#!/usr/bin/env bash
# Install/refresh third-party agent skills into .agents/skills/ (+ mirrors).
#
# These skills are install output, not source: .gitignore covers every
# harness root except the repo-built adapters whitelisted there, and the
# third-party trees were removed from source control. skills-lock.json is
# the catalogue (which skills, from which sources); installation is
# deliberately LATEST/UNPINNED — every run installs missing skills at
# upstream latest and updates installed ones. Tiers live in
# skills/profiles.json. First-party skills in skills/ are tracked source
# and need no install; core validation passes without any of this.
#
# Runs on every devcontainer start (postStartCommand, which also covers
# first creation) and via `pnpm skills:install`. Safe to re-run.
# Per-skill failures warn and continue (optional profiles may be absent,
# e.g. offline); the final sync --check is the gate.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
warn() { echo "install-agent-skills: WARN: $*" >&2; }

# 1. Install missing catalogue skills at upstream latest
#    (lock key stitch::x installs as stitch-x/).
missing=$(node -e "
  const fs = require('fs');
  const lock = JSON.parse(fs.readFileSync('skills-lock.json', 'utf8'));
  for (const [name, meta] of Object.entries(lock.skills)) {
    const dir = name.replace('stitch::', 'stitch-');
    if (!fs.existsSync('.agents/skills/' + dir + '/SKILL.md'))
      console.log(name + '\t' + meta.source);
  }
")
if [ -n "$missing" ]; then
  printf '%s\n' "$missing" | while IFS="$(printf '\t')" read -r name source; do
    echo "install-agent-skills: adding $name from $source (latest)"
    # Explicit agents only: '*' also writes Universal (./skills/) and
    # OpenClaw (./agent/) roots this repo does not use. Codex, Copilot,
    # OpenCode, and Gemini discover .agents/skills natively; Claude Code
    # and Grok need their mirror symlinks.
    timeout 300 npx -y skills add "$source" -s "$name" -a claude-code -a grok --full-depth -y </dev/null \
      || warn "could not install optional skill $name"
  done
fi

# 2. Refresh everything already installed to upstream latest.
timeout 600 npx -y skills update -y </dev/null \
  || warn "skills update failed (offline?); keeping installed versions"

# 3. impeccable ships its own installer/updater (not in skills-lock.json).
if [ -f .agents/skills/impeccable/SKILL.md ]; then
  timeout 600 npx -y impeccable update </dev/null \
    || warn "could not update optional skill impeccable"
else
  timeout 600 npx -y impeccable install </dev/null \
    || warn "could not install optional skill impeccable"
fi

# 4. design-system is a TypeUI pull (not in skills-lock.json); re-pull latest.
timeout 300 npx -y typeui.sh pull minimal -f skill -p claude-code </dev/null \
  || warn "could not refresh optional skill design-system"
if [ ! -f .agents/skills/design-system/SKILL.md ] && [ -f .claude/skills/design-system/SKILL.md ]; then
  mkdir -p .agents/skills/design-system
  cp -r .claude/skills/design-system/. .agents/skills/design-system/
fi

# 5. Container Chromium patch for scandinavian-design verifiers: the tracked
#    repo previously carried this as a patched .claude variant; installed
#    copies are patched in place instead (ignored output, re-applied here
#    after every update).
for f in .agents/skills/scandinavian-design/scripts/density.js \
         .agents/skills/scandinavian-design/scripts/lines.js \
         .agents/skills/scandinavian-design/scripts/tints.js; do
  if [ -f "$f" ]; then
    perl -pi -e "s/channel: 'chrome',/executablePath: process.env.PLAYWRIGHT_CHROMIUM || '\/opt\/pw-browsers\/chromium',/" "$f"
  fi
done

# 6. Installers materialize real copies in harness mirrors; collapse them
#    to links, then restore tracked adapters/lock that installers rewrite
#    (impeccable refreshes .codex/hooks.json entries; the skills CLI rewrites
#    lock hashes on every update). Installed content floats to latest;
#    tracked files only change in reviewed commits.
node scripts/dev/sync-agent-skills.mjs || warn "skill mirror sync reported problems"
git checkout -- .codex/hooks.json .claude/settings.json skills-lock.json 2>/dev/null || true
node scripts/dev/sync-agent-skills.mjs --check
