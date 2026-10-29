#!/usr/bin/env bash
# Restore third-party agent skills into .agents/skills/ (+ harness mirrors).
#
# These skills are install output, not source: .gitignore covers every
# harness root except the repo-built adapters whitelisted there, and the
# third-party trees were removed from source control. The selection is
# pinned by skills-lock.json (vercel-labs/skills) and tiered by
# skills/profiles.json. First-party skills in skills/ are tracked source
# and need no install; core validation passes without any of this.
#
# Runs at devcontainer creation (postCreateCommand). Safe to re-run.
# Per-skill failures warn and continue (optional profiles may be absent);
# the final sync --check is the gate.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
warn() { echo "install-agent-skills: WARN: $*" >&2; }

# 1. Restore everything pinned in skills-lock.json.
if ! timeout 600 npx -y skills experimental_install -y </dev/null; then
  warn "skills experimental_install failed; falling back to per-skill add"
fi

# 2. Fill any gaps per skill (lock key stitch::x installs as stitch-x/).
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
    echo "install-agent-skills: adding $name from $source"
    timeout 300 npx -y skills add "$source" -s "$name" -a '*' -y </dev/null \
      || warn "could not install optional skill $name"
  done
fi

# 3. impeccable ships its own installer/updater (not in skills-lock.json).
if [ ! -f .agents/skills/impeccable/SKILL.md ]; then
  timeout 600 npx -y impeccable install </dev/null \
    || warn "could not install optional skill impeccable"
fi

# 4. design-system is a TypeUI pull (not in skills-lock.json).
if [ ! -f .agents/skills/design-system/SKILL.md ]; then
  timeout 300 npx -y typeui.sh pull minimal -f skill -p claude-code </dev/null \
    || warn "could not install optional skill design-system"
  if [ ! -f .agents/skills/design-system/SKILL.md ] && [ -f .claude/skills/design-system/SKILL.md ]; then
    mkdir -p .agents/skills/design-system
    cp -r .claude/skills/design-system/. .agents/skills/design-system/
  fi
fi

# 5. Container Chromium patch for scandinavian-design verifiers: the tracked
#    repo previously carried this as a patched .claude variant; installed
#    copies are patched in place instead (ignored output, re-applied here).
for f in .agents/skills/scandinavian-design/scripts/density.js \
         .agents/skills/scandinavian-design/scripts/lines.js \
         .agents/skills/scandinavian-design/scripts/tints.js; do
  if [ -f "$f" ]; then
    perl -pi -e "s/channel: 'chrome',/executablePath: process.env.PLAYWRIGHT_CHROMIUM || '\/opt\/pw-browsers\/chromium',/" "$f"
  fi
done

# 6. Whatever mirrors the installers materialized must satisfy the checker.
node scripts/dev/sync-agent-skills.mjs --check
