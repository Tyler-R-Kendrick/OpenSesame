import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeJsonText } from "./json-text.mjs";
import { readPinnedFile } from "./read-pinned-file.mjs";

export const EVIDENCE_ROOT = "docs/evidence";
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const dated = /(?:^|-)\d{4}(?:-|$)|(?:^|-)(?:v|r|round)\d+(?:-|$)/u;
const historical =
  /(?:^|[./_-])(?:before|comparison|comparisons|history|historical|archive|archived)(?:[./_-]|$)/iu;

export function assertSlot(slot) {
  const parts = slot.split("/");
  if (
    parts.length !== 3 ||
    parts.some((part) => !slug.test(part) || dated.test(part))
  ) {
    throw new Error(
      `invalid evidence slot ${slot}: expected feature/project/platform kebab names without dates or revisions`,
    );
  }
  return slot;
}

export function assertPayloadPath(name) {
  if (
    !name ||
    name.includes("\\") ||
    name
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("."),
      )
  ) {
    throw new Error(`unsafe evidence path ${name}`);
  }
  if (
    historical.test(name) ||
    name.split("/").some((part) => dated.test(part))
  ) {
    throw new Error(`historical/comparison evidence is temporary: ${name}`);
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertNoSymlinkParents(path) {
  let cursor = resolve(path);
  while (cursor !== dirname(cursor)) {
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink())
      throw new Error(`evidence symlink refused: ${cursor}`);
    cursor = dirname(cursor);
  }
}

/** Read without following symlinks. Keys use repository-style forward slashes. */
export function readTree(directory) {
  assertNoSymlinkParents(directory);
  const files = new Map();
  function visit(absolute, relative) {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error(`evidence symlink refused: ${relative || directory}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        visit(join(absolute, name), relative ? `${relative}/${name}` : name);
      }
    } else if (stat.isFile()) {
      files.set(relative, readPinnedFile(absolute, stat).bytes);
    } else {
      throw new Error(`non-file evidence refused: ${relative}`);
    }
  }
  visit(directory, "");
  return files;
}

function readManifest(slot, files) {
  if (!files.has("README.md")) throw new Error(`${slot}: missing README.md`);
  if (!files.get("README.md").toString().trim())
    throw new Error(`${slot}: empty README.md`);
  if (!files.has("manifest.json"))
    throw new Error(`${slot}: missing manifest.json`);
  return JSON.parse(files.get("manifest.json").toString());
}

function validateApproval(slot, manifest) {
  if (manifest.version !== 1 || manifest.status !== "approved")
    throw new Error(`${slot}: evidence must be approved manifest version 1`);
  if (!/^[a-f0-9]{40}$/u.test(manifest.sourceCommit ?? ""))
    throw new Error(`${slot}: sourceCommit must be a full commit SHA`);
  if (
    !manifest.approval ||
    [manifest.approval.by, manifest.approval.reference].some(
      (value) =>
        !decodeJsonText(
          value,
          `${slot}: approval by and reference are required`,
        ).trim(),
    )
  ) {
    throw new Error(`${slot}: approval by and reference are required`);
  }
}

function validateInventory(slot, files, inventory) {
  if (!Array.isArray(inventory))
    throw new Error(`${slot}: files inventory required`);
  const listed = new Set();
  for (const entry of inventory) {
    const path = decodeJsonText(
      entry?.path,
      `${slot}: invalid inventory entry`,
    );
    assertPayloadPath(path);
    if (path === "manifest.json" || listed.has(path))
      throw new Error(`${slot}: duplicate or self-listed file ${path}`);
    listed.add(path);
    if (!files.has(path))
      throw new Error(`${slot}: missing listed file ${path}`);
    if (sha256(files.get(path)) !== entry.sha256)
      throw new Error(`${slot}: hash mismatch ${path}`);
  }
  for (const name of files.keys()) {
    if (name !== "manifest.json" && !listed.has(name))
      throw new Error(`${slot}: unlisted file ${name}`);
  }
}

/** Validate exact persisted inventory; a reviewer approves the content, not this script. */
export function validateSlot(slot, files) {
  assertSlot(slot);
  for (const name of files.keys()) assertPayloadPath(name);
  const manifest = readManifest(slot, files);
  validateApproval(slot, manifest);
  validateInventory(slot, files, manifest.files);
  return manifest;
}

export function validateEvidence(files) {
  const slots = new Map();
  for (const [name, bytes] of files) {
    if (name === "README.md") continue;
    const parts = name.split("/");
    if (parts.length < 4)
      throw new Error(
        `invalid evidence location ${name}: expected feature/project/platform/file`,
      );
    const slot = assertSlot(parts.slice(0, 3).join("/"));
    if (!slots.has(slot)) slots.set(slot, new Map());
    slots.get(slot).set(parts.slice(3).join("/"), bytes);
  }
  return [...slots].map(([slot, payloads]) => ({
    slot,
    manifest: validateSlot(slot, payloads),
  }));
}
