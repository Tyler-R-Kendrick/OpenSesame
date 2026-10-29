#!/usr/bin/env bash
# Install absent optional skills from the previously tracked snapshot.
# Existing user content and hooks are never replaced or cleaned up. Refreshes
# require a reviewed change to both the commit and the expected tree below.
set -euo pipefail
# Repository-local replacement refs must not substitute the pinned objects.
export GIT_NO_REPLACE_OBJECTS=1
readonly SOURCE_COMMIT=ae450dbce41860c69f0fa3f6f1ae40dce28b6126
readonly SOURCE_SKILLS_TREE=8a0c19e12401350dc4d87b9b6436ceeca4acb5c4
warn() { echo "install-agent-skills: $*" >&2; }

# Anchor the .agents inode before using it as the working directory. Python's
# fchdir works on both Linux and macOS, including when /dev/fd cannot be cd'd.
if [[ "${1:-}" != --anchored ]]; then
  cd "$(dirname "$0")/../.."
  root=$(pwd -P)
  if [[ -L .agents ]]; then warn '.agents is a symlink'; exit 1; fi
  mkdir -p .agents
  exec 8<.agents
  exec python3 - "$root" <<'PYANCHOR'
import os
import stat
import sys
root = sys.argv[1]
entry = os.lstat(os.path.join(root, ".agents"))
opened = os.fstat(8)
if not stat.S_ISDIR(entry.st_mode) or (entry.st_dev, entry.st_ino) != (opened.st_dev, opened.st_ino):
    raise SystemExit("skill root changed while opening")
os.fchdir(8)
os.set_inheritable(8, True)
os.execv("/bin/bash", ["bash", os.path.join(root, "scripts/dev/install-agent-skills.sh"), "--anchored", root])
PYANCHOR
fi
root="${2:?missing checkout root}"
python3 - 8 <<'PYANCHOR'
import os
import sys
opened = os.fstat(int(sys.argv[1]))
cwd = os.stat(".")
if (cwd.st_dev, cwd.st_ino) != (opened.st_dev, opened.st_ino):
    raise SystemExit("skill root descriptor does not match working directory")
PYANCHOR
if [[ -L skills ]]; then warn '.agents/skills is a symlink'; exit 1; fi
mkdir -p skills
exec 9<skills
python3 - skills 9 <<'PYANCHOR'
import os
import stat
import sys
entry = os.lstat(sys.argv[1])
opened = os.fstat(int(sys.argv[2]))
if not stat.S_ISDIR(entry.st_mode) or (entry.st_dev, entry.st_ino) != (opened.st_dev, opened.st_ino):
    raise SystemExit("skill directory changed while opening")
PYANCHOR
lock_dir=.skills-install.lockdir
if ! mkdir "$lock_dir" 2>/dev/null; then
  warn "installer lock exists at $lock_dir; leave it until the other installer finishes"
  exit 1
fi
tmp=""
keep_snapshot=false
cleanup() {
  if [[ -n "$tmp" && "$keep_snapshot" != true ]]; then rm -rf "$tmp"; fi
  rmdir "$lock_dir" || warn "could not remove installer lock $lock_dir"
}
trap cleanup EXIT
if ! git -C "$root" cat-file -e "$SOURCE_COMMIT^{commit}" 2>/dev/null; then
  python3 - "$SOURCE_COMMIT" "$root" <<'PYFETCH' || {
import subprocess
import sys
try:
    subprocess.run(["git", "-C", sys.argv[2], "fetch", "--no-tags", "--no-write-fetch-head", "origin", sys.argv[1]], check=True, timeout=60)
except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
    raise SystemExit(1)
PYFETCH
    warn 'pinned skill snapshot is unavailable; optional skills remain absent'; exit 0;
  }
fi
[[ "$(git -C "$root" rev-parse "$SOURCE_COMMIT:.agents/skills")" == "$SOURCE_SKILLS_TREE" ]] || {
  warn 'pinned skill snapshot tree does not match the pin'; exit 1;
}
tmp=$(mktemp -d .skill-install.XXXXXXXX)
node - "$root/skills/profiles.json" > "$tmp/names" <<'JSPROFILES'
  const p = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
  for (const profile of Object.values(p.profiles)) {
    if (profile.required !== false) continue;
    for (const name of profile.skills) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw Error("Invalid skill name");
      console.log(name);
    }
  }
JSPROFILES
ensure_mirrors() {
  python3 - "$1" "$root" <<'PYMIRROR'
import os
import sys

name = sys.argv[1]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
root = os.open(sys.argv[2], flags)
try:
    for agent in (".claude", ".grok"):
        try:
            try:
                os.mkdir(agent, dir_fd=root)
            except FileExistsError:
                pass
            agent_fd = os.open(agent, flags, dir_fd=root)
            try:
                try:
                    os.mkdir("skills", dir_fd=agent_fd)
                except FileExistsError:
                    pass
                skills_fd = os.open("skills", flags, dir_fd=agent_fd)
                try:
                    try:
                        os.symlink(f"../../.agents/skills/{name}", name, dir_fd=skills_fd)
                    except FileExistsError:
                        pass
                finally:
                    os.close(skills_fd)
            finally:
                os.close(agent_fd)
        except OSError as error:
            print(f"install-agent-skills: skipping unsafe or unavailable mirror {agent}: {error}", file=sys.stderr)
finally:
    os.close(root)
PYMIRROR
}
while IFS= read -r name; do
  dest="skills/$name"
  archive_path=".agents/skills/$name"
  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ -f "$dest/SKILL.md" ]]; then ensure_mirrors "$name"; fi
    continue
  fi
  tree="$SOURCE_COMMIT:.agents/skills/$name"
  [[ "$(git -C "$root" cat-file -t "$tree" 2>/dev/null || true)" == tree ]] || {
    warn "missing pinned tree for $name"; exit 1;
  }
  # Refuse symlinks and submodules before archive extraction. The pinned tree
  # contains only regular files, so no archive entry can escape the staging dir.
  if git -C "$root" ls-tree -r "$tree" | grep -vE '^100(644|755) blob [0-9a-f]{40}[[:space:]]' > "$tmp/invalid"; then
    warn "unsupported entry in pinned tree for $name"; exit 1;
  fi
  mkdir -p "$tmp/stage"
  git -C "$root" archive --format=tar "$SOURCE_COMMIT" -- "$archive_path" | tar -xf - -C "$tmp/stage"
  [[ -f "$tmp/stage/$archive_path/SKILL.md" ]] || { warn "missing SKILL.md for $name"; exit 1; }
  git -C "$root" ls-tree -rz "$tree" > "$tmp/entries"
  python3 - "$tmp/entries" "$tmp/stage/$archive_path" <<'PYVERIFY'
import hashlib
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[2])
expected = {}
for record in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0"):
    if not record:
        continue
    meta, raw_path = record.split(b"\t", 1)
    mode, kind, oid = meta.decode("ascii").split(" ")
    path = os.fsdecode(raw_path)
    if mode not in ("100644", "100755") or kind != "blob":
        raise SystemExit("unsupported pinned tree entry")
    expected[path] = (mode, oid)
actual = set()
for directory, dirs, files in os.walk(root, followlinks=False):
    base = pathlib.Path(directory)
    for name in dirs:
        if (base / name).is_symlink():
            raise SystemExit("unexpected link in staged skill")
    for name in files:
        path = base / name
        if path.is_symlink() or not path.is_file():
            raise SystemExit("unexpected staged skill entry")
        rel = str(path.relative_to(root))
        actual.add(rel)
        if rel not in expected:
            raise SystemExit("unexpected staged skill file")
        mode, oid = expected[rel]
        data = path.read_bytes()
        header = f"blob {len(data)}\0".encode("ascii")
        if hashlib.sha1(header + data).hexdigest() != oid:
            raise SystemExit("staged skill file digest mismatch")
        if bool(path.stat().st_mode & 0o111) != (mode == "100755"):
            raise SystemExit("staged skill executable mode mismatch")
if actual != set(expected):
    raise SystemExit("incomplete staged skill")
PYVERIFY
  # The previous tracked version uses Chrome's channel. Only newly staged,
  # verified copies receive this fixed compatibility transformation.
  if [[ "$name" == scandinavian-design ]]; then
    python3 - "$tmp/stage/$archive_path" <<'PYPATCH'
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
old = "channel: 'chrome',"
new = ("...(() => {\n"
       "      const pinned = '/opt/pw-browsers/chromium';\n"
       "      const executablePath = process.env.PLAYWRIGHT_CHROMIUM || (fs.existsSync(pinned) ? pinned : undefined);\n"
       "      return executablePath ? { executablePath } : { channel: 'chrome' };\n"
       "    })(),")
for name in ("density.js", "lines.js", "tints.js"):
    path = root / "scripts" / name
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit(f"unexpected Chromium launcher in {name}")
    path.write_text(source.replace(old, new))
PYPATCH
  fi
  # Publish the fully verified staged directory through a single no-replace
  # symlink operation. The unique private staging directory stays in place for
  # every installed skill. An existing destination is never entered or changed.
  snapshot_link="../${tmp##*/}/stage/$archive_path"
  # Persist before publication so a signal after symlink creation cannot
  # delete the snapshot behind an already discoverable skill.
  keep_snapshot=true
  if python3 - "$name" "$snapshot_link" <<'PYINSTALL'
import os
import sys
try:
    os.symlink(sys.argv[2], sys.argv[1], dir_fd=9)
except FileExistsError:
    raise SystemExit(2)
PYINSTALL
  then
    echo "install-agent-skills: installed pinned snapshot of $name"
  else
    result=$?
    if [[ "$result" != 2 ]]; then
      warn "could not publish $name"
      exit "$result"
    fi
  fi
  if [[ -f "$dest/SKILL.md" ]]; then ensure_mirrors "$name"; fi
done < "$tmp/names"
