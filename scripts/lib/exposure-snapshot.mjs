/** Source snapshots for the exposure gate. Reads never fall back to another tree. */
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeJsonText } from "./json-text.mjs";
import { readPinnedFile } from "./read-pinned-file.mjs";

const OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REGULAR = new Set(["100644", "100755"]);
const MODES = new Set([...REGULAR, "120000", "160000"]);
const MAX_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function git(root, args) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    maxBuffer: MAX_BYTES,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repositoryRoot(root) {
  const canonical = realpathSync(resolve(root));
  const reported = decoder
    .decode(git(canonical, ["rev-parse", "--show-toplevel"]))
    .replace(/\r?\n$/u, "");
  if (realpathSync(reported) !== canonical)
    throw new Error("Snapshot root must be the repository root");
  return canonical;
}

function canonicalPath(value) {
  const path = decodeJsonText(
    value,
    "Snapshot path must be a canonical relative path",
  );
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    hasControl(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Snapshot path must be a canonical relative path");
  return path;
}

function hasControl(text, space = false) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f || (space && code === 0x20);
  });
}

function records(bytes) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error("Malformed Git snapshot listing");
  return decoder.decode(bytes.subarray(0, -1)).split("\0");
}

function snapshot(label, entries, load) {
  const contents = new Map();
  function entry(path) {
    const found = entries.get(path);
    if (!found) throw new Error(`Missing snapshot path: ${path}`);
    if (found.error) throw found.error;
    return found;
  }
  return {
    label,
    paths: () => [...entries.keys()].sort(),
    mode(path) {
      return entry(canonicalPath(path)).mode;
    },
    read(path) {
      const requested = canonicalPath(path);
      const found = entry(requested);
      if (!REGULAR.has(found.mode))
        throw new Error(`Unsafe snapshot mode ${found.mode}: ${requested}`);
      if (!contents.has(requested))
        contents.set(requested, load(requested, found));
      // A consumer must not be able to alter the cached snapshot for another rule.
      return Buffer.from(contents.get(requested));
    },
  };
}

function stat(root, path) {
  const parts = path.split("/");
  let parent = root;
  try {
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = lstatSync(parent);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe snapshot parent: ${path}`);
    }
    return lstatSync(join(root, path));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function sameStat(left, right) {
  return (
    right !== null &&
    ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].every(
      (key) => left[key] === right[key],
    )
  );
}

/** Current cached paths plus nonignored untracked files; missing files are absent. */
export function worktreeSnapshot(directory) {
  const root = repositoryRoot(directory);
  const names = new Set(
    records(
      git(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    ),
  );
  const entries = new Map();
  for (const name of names) {
    canonicalPath(name);
    try {
      const info = stat(root, name);
      if (!info) continue;
      const mode = info.isFile()
        ? info.mode & 0o111
          ? "100755"
          : "100644"
        : info.isSymbolicLink()
          ? "120000"
          : "040000";
      entries.set(name, { mode, info });
    } catch (error) {
      // Keep unsafe parents visible to protected-path inventory checks.
      entries.set(name, { error });
    }
  }
  return snapshot("working tree", entries, (name, entry) => {
    if (entry.info.size > MAX_BYTES)
      throw new Error(`Snapshot source exceeds size limit: ${name}`);
    if (!sameStat(entry.info, stat(root, name)))
      throw new Error(`File changed during snapshot: ${name}`);
    const { bytes } = readPinnedFile(join(root, name), entry.info);
    if (!sameStat(entry.info, stat(root, name)))
      throw new Error(`File changed during snapshot: ${name}`);
    return bytes;
  });
}

/** The complete index, pinned by blob ID rather than working-tree contents. */
export function indexSnapshot(directory) {
  const root = repositoryRoot(directory);
  const entries = new Map();
  for (const record of records(git(root, ["ls-files", "--stage", "-z"]))) {
    const tab = record.indexOf("\t");
    const [mode, object, stage, extra] = record.slice(0, tab).split(" ");
    if (
      tab < 0 ||
      extra !== undefined ||
      !MODES.has(mode) ||
      !OBJECT.test(object) ||
      !/^[0-3]$/u.test(stage)
    )
      throw new Error("Malformed index snapshot entry");
    const name = canonicalPath(record.slice(tab + 1));
    const previous = entries.get(name);
    if (stage !== "0" || previous) {
      entries.set(name, { error: new Error(`Unresolved index path: ${name}`) });
    } else {
      entries.set(name, { mode, object });
    }
  }
  return snapshot("index", entries, (_name, entry) =>
    git(root, ["cat-file", "blob", entry.object]),
  );
}

/** An immutable commit tree; annotated tags are peeled, replace refs are ignored. */
export function revisionSnapshot(directory, revision) {
  const root = repositoryRoot(directory);
  const ref = decodeJsonText(revision, "Invalid snapshot revision");
  if (!ref || hasControl(ref, true))
    throw new Error("Invalid snapshot revision");
  const commit = decoder
    .decode(
      git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]),
    )
    .trim();
  if (!OBJECT.test(commit)) throw new Error("Invalid snapshot commit");
  const entries = new Map();
  for (const record of records(
    git(root, ["ls-tree", "-r", "-z", "--full-tree", commit]),
  )) {
    const tab = record.indexOf("\t");
    const [mode, type, object, extra] = record.slice(0, tab).split(" ");
    if (
      tab < 0 ||
      extra !== undefined ||
      !MODES.has(mode) ||
      !OBJECT.test(object) ||
      type !== (mode === "160000" ? "commit" : "blob")
    )
      throw new Error("Malformed revision snapshot entry");
    entries.set(canonicalPath(record.slice(tab + 1)), { mode, object });
  }
  return snapshot(`commit:${commit}`, entries, (_name, entry) =>
    git(root, ["cat-file", "blob", entry.object]),
  );
}

/** Native pre-push tuples identify the actual pushed commits, including other branches. */
export function pushedSnapshots(root, input) {
  const text = Buffer.isBuffer(input)
    ? decoder.decode(input)
    : decodeJsonText(input, "Invalid pre-push input");
  if (text.trim() === "") return [revisionSnapshot(root, "HEAD")];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const snapshots = new Map();
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const fields = line.split(" ");
    if (
      fields.length !== 4 ||
      fields.some((field) => !field || hasControl(field, true)) ||
      !OBJECT.test(fields[1]) ||
      !OBJECT.test(fields[3]) ||
      fields[1].length !== fields[3].length
    )
      throw new Error("Malformed pre-push tuple");
    if (/^0+$/u.test(fields[1])) continue;
    const candidate = revisionSnapshot(root, fields[1]);
    snapshots.set(candidate.label, candidate);
  }
  return [...snapshots.values()];
}
