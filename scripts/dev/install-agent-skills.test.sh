#!/usr/bin/env bash
# Integration proof using the real immutable source tree and isolated outputs.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
objects=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(git rev-parse --git-path objects)")
git cat-file -e ae450dbce41860c69f0fa3f6f1ae40dce28b6126^{commit}
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
git init -q "$tmp/repo"
printf '%s\n' "$objects" > "$tmp/repo/.git/objects/info/alternates"
cd "$tmp/repo"
mkdir -p scripts/dev skills .cursor .agents/skills/design-md .claude/skills/impeccable
cp "$root/scripts/dev/install-agent-skills.sh" scripts/dev/
cp "$root/skills/profiles.json" skills/
printf '%s\n' '{"hooks":{"PostToolUse":[{"command":"impeccable"},{"command":"personal"}]}}' > .cursor/hooks.json
printf '%s\n' 'PERSONAL ORIGINAL' > .agents/skills/design-md/SKILL.md
printf '%s\n' 'PERSONAL MIRROR' > .claude/skills/impeccable/SKILL.md
# Prove local replacement refs exist and cannot redirect the pinned tree.
bad_blob=$(printf '%s' hostile | git hash-object -w --stdin)
bad_tree=$(printf '100644 blob %s\tSKILL.md\n' "$bad_blob" | git mktree)
git replace 8a0c19e12401350dc4d87b9b6436ceeca4acb5c4 "$bad_tree"
git ls-tree 8a0c19e12401350dc4d87b9b6436ceeca4acb5c4 | grep -Fq SKILL.md
bash scripts/dev/install-agent-skills.sh
cmp .cursor/hooks.json <(printf '%s\n' '{"hooks":{"PostToolUse":[{"command":"impeccable"},{"command":"personal"}]}}')
cmp .agents/skills/design-md/SKILL.md <(printf '%s\n' 'PERSONAL ORIGINAL')
cmp .claude/skills/impeccable/SKILL.md <(printf '%s\n' 'PERSONAL MIRROR')
test -f .agents/skills/enhance-prompt/SKILL.md
test "$(readlink .grok/skills/design-md)" = ../../.agents/skills/design-md
test "$(readlink .claude/skills/design-md)" = ../../.agents/skills/design-md
for file in density.js lines.js tints.js; do
  node --check ".agents/skills/scandinavian-design/scripts/$file"
done
node <<'JSBROWSER'
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
for (const name of ['density.js', 'lines.js', 'tints.js']) {
  const source = fs.readFileSync(`.agents/skills/scandinavian-design/scripts/${name}`, 'utf8');
  const start = source.indexOf('...(() => {');
  const end = source.indexOf('})(),', start);
  assert.ok(start >= 0 && end > start);
  const expression = source.slice(start + 3, end + 4);
  const pick = (configured, exists) => JSON.stringify(vm.runInNewContext(expression, {
    process: { env: { PLAYWRIGHT_CHROMIUM: configured } },
    fs: { existsSync: () => exists },
  }));
  assert.equal(pick('/custom/browser', false), JSON.stringify({executablePath:'/custom/browser'}));
  assert.equal(pick(undefined, true), JSON.stringify({executablePath:'/opt/pw-browsers/chromium'}));
  assert.equal(pick(undefined, false), JSON.stringify({channel:'chrome'}));
}
JSBROWSER
test "$(readlink .grok/skills/enhance-prompt)" = ../../.agents/skills/enhance-prompt
bash scripts/dev/install-agent-skills.sh
# Simulate a non-cooperating writer publishing a directory at the exact
# no-replace boundary; its symlink and personal file must stay untouched.
rm .agents/skills/enhance-prompt
mkdir -p "$tmp/shim" "$tmp/personal"
printf '%s\n' 'PERSONAL RACE' > "$tmp/personal/content"
cat > "$tmp/shim/python3" <<'PYSHIM'
#!/usr/bin/env bash
if [[ "${2:-}" == enhance-prompt ]]; then
  mkdir skills/enhance-prompt
  ln -s "$TEST_RACE_ROOT/personal" skills/enhance-prompt/refs
fi
exec "$TEST_REAL_PYTHON" "$@"
PYSHIM
chmod +x "$tmp/shim/python3"
TEST_RACE_ROOT="$tmp" TEST_REAL_PYTHON="$(command -v python3)" PATH="$tmp/shim:$PATH" bash scripts/dev/install-agent-skills.sh
cmp "$tmp/personal/content" <(printf '%s\n' 'PERSONAL RACE')
test -L .agents/skills/enhance-prompt/refs
test ! -e .agents/skills/enhance-prompt/SKILL.md
# A termination immediately after publishing must not remove the backing tree.
rm .agents/skills/enhance-prompt/refs
rmdir .agents/skills/enhance-prompt
cat > "$tmp/shim/python3" <<'PYSHIM'
#!/usr/bin/env bash
if [[ "${2:-}" == enhance-prompt ]]; then
  "$TEST_REAL_PYTHON" "$@"
  result=$?
  if [[ "$result" == 0 ]]; then kill -TERM "$PPID"; fi
  exit "$result"
fi
exec "$TEST_REAL_PYTHON" "$@"
PYSHIM
chmod +x "$tmp/shim/python3"
if TEST_REAL_PYTHON="$(command -v python3)" PATH="$tmp/shim:$PATH" bash scripts/dev/install-agent-skills.sh; then
  echo 'interrupted installer unexpectedly completed' >&2
  exit 1
fi
test -L .agents/skills/enhance-prompt
test -f .agents/skills/enhance-prompt/SKILL.md
bash scripts/dev/install-agent-skills.sh
test -f .agents/skills/enhance-prompt/SKILL.md
# Refuse mirror roots redirected outside the checkout.
rm -r .grok
ln -s "$tmp/personal" .grok
bash scripts/dev/install-agent-skills.sh
test ! -e "$tmp/personal/skills"
test -L .grok
mkdir .agents/.skills-install.lockdir
if bash scripts/dev/install-agent-skills.sh; then
  echo 'concurrent installer lock was accepted' >&2
  exit 1
fi
test -d .agents/.skills-install.lockdir
rmdir .agents/.skills-install.lockdir
bash scripts/dev/install-agent-skills.sh
# A concurrent replacement of the root must not redirect cleanup outside.
mkdir -p "$tmp/root-shim" "$tmp/outside"
cat > "$tmp/root-shim/node" <<'NODESHIM'
#!/usr/bin/env bash
for entry in .skill-install.*; do
  [[ -d "$entry" ]] || continue
  mkdir -p "$TEST_REPO/outside/$entry"
  printf '%s\n' PERSONAL > "$TEST_REPO/outside/$entry/keep"
done
mv "$TEST_REPO/.agents" "$TEST_REPO/.agents-original"
ln -s "$TEST_REPO/outside" "$TEST_REPO/.agents"
exit 1
NODESHIM
chmod +x "$tmp/root-shim/node"
if TEST_REPO="$PWD" PATH="$tmp/root-shim:$PATH" bash scripts/dev/install-agent-skills.sh; then
  echo 'root-swap test unexpectedly completed' >&2
  exit 1
fi
for entry in outside/.skill-install.*; do
  [[ -d "$entry" ]] || continue
  cmp "$entry/keep" <(printf '%s\n' PERSONAL)
done
rm .agents
mv .agents-original .agents
cmp .agents/skills/design-md/SKILL.md <(printf '%s\n' 'PERSONAL ORIGINAL')
python3 - <<'PYMUTATE'
from pathlib import Path
path = Path('scripts/dev/install-agent-skills.sh')
content = path.read_text()
path.write_text(content.replace('8a0c19e12401350dc4d87b9b6436ceeca4acb5c4', '0000000000000000000000000000000000000000'))
PYMUTATE
if bash scripts/dev/install-agent-skills.sh; then
  echo 'invalid snapshot tree was accepted' >&2
  exit 1
fi
printf '%s\n' 'install-agent-skills integration checks passed'
