/**
 * Where a secret lives on disk (ADR 0182): `secrets/<folder>/<name>.<kind>.json`
 * inside the vault's directory. The name is the one a person gave the secret,
 * made safe for every file system a vault might sit on, so a directory of
 * secrets reads like the folders it is organised into and one file can be
 * listed, diffed, copied, shared or locked down on its own.
 *
 * A name is a label and never the secret's identity: the manifest maps each
 * item id to its file, so renaming a secret moves its file and a collision is
 * settled by suffixing the id — nothing breaks because a name repeats.
 * `spec/conformance/secret-file-layout-vectors.json` pins these rules so the
 * native plane can lay out the same tree.
 */
export const SECRETS_DIR = "secrets";
import { STAGING_SUFFIX } from "./files.js";

const MAX_NAME = 80;
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One path segment: ASCII letters, digits and `._+=@-`, never leading with a symbol. */
export function slugSegment(raw: string): string {
  const folded = raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9._+=@-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, MAX_NAME)
    .replace(/[.-]+$/, "");
  const base = folded === "" ? "item" : folded;
  // A Windows device name is reserved with any extension (`COM1.txt`).
  if (RESERVED_BASE.test(base.split(".")[0] ?? "")) {
    return base.replace(/^[^.]*/, (device) => `${device}-item`);
  }
  // A name a store keeps for its own half-written files.
  return base.endsWith(STAGING_SUFFIX) ? `${base}-item` : base;
}

function folderSegments(folder: string | null): string[] {
  return (folder ?? "")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .map(slugSegment);
}

export type SecretFileName = Readonly<{
  folder: string | null;
  name: string;
  /** The item's kind, or its type id for a plugin-defined item. */
  kind: string;
  id: string;
}>;

/**
 * The file for a secret: `secrets/<folder>/<name>.<kind>.json`, or, when that
 * path is already held by another secret, `<name>~<id>…` with as much of the
 * id as it takes. Case is ignored in comparing, because a vault copied to a Mac
 * or a Windows share must not merge two files into one.
 */
export function secretFilePath(
  file: SecretFileName,
  held: ReadonlySet<string>,
): string {
  const directory = [SECRETS_DIR, ...folderSegments(file.folder)].join("/");
  const kind = slugSegment(file.kind).toLowerCase();
  const base = slugSegment(file.name);
  const taken = new Set([...held].map((path) => path.toLowerCase()));
  const id = slugSegment(file.id);
  for (let length = 0; length <= id.length; length += 1) {
    const label =
      length === 0 ? base : `${base}~${id.slice(0, Math.max(length, 6))}`;
    const path = `${directory}/${label}.${kind}.json`;
    if (!taken.has(path.toLowerCase())) return path;
  }
  return `${directory}/${base}~${id}.${kind}.json`;
}
