import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  SEAL_BOUND_MARKER_PATH,
  tombFileKey,
  vfsSeams,
} from "../vfs.js";

/** Ciphertext-only recovery record. Never contains an opened body or raw key. */
export const ROTATION_JOURNAL_PATH = "rotation-journal.v1";
export const ROTATION_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
export const ROTATION_JOURNAL_MAX_FILES = 1024;
export type RotationJournalInput = {
  tomb: string;
  token: string;
  previousHeader: string;
  nextHeader: string;
  files: Record<string, string>;
};
type RotationJournal = RotationJournalInput & { v: 1 };

function invalid(): never {
  throw new Error("Invalid vault rotation journal");
}
function parseObject(raw: string): Record<string, BoundaryValue> {
  const value: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(value)) invalid();
  return value;
}
function validateSeal(raw: string): void {
  const value = parseObject(raw);
  if (
    Object.keys(value).length !== 2 ||
    !isString(value.ivB64) ||
    !isString(value.ctB64)
  )
    invalid();
  if (
    !/^[A-Za-z0-9+/]{16}$/.test(value.ivB64) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ctB64) ||
    value.ctB64.length % 4 !== 0 ||
    value.ctB64.length < 24
  )
    invalid();
}
function validate(input: RotationJournalInput): void {
  tombFileKey(input.tomb, ROTATION_JOURNAL_PATH);
  if (!input.token || input.token.length > 128) invalid();
  parseObject(input.previousHeader);
  parseObject(input.nextHeader);
  const entries = Object.entries(input.files);
  if (
    entries.length > ROTATION_JOURNAL_MAX_FILES ||
    !Object.hasOwn(input.files, BODY_PATH) ||
    !Object.hasOwn(input.files, INDEX_PATH)
  )
    invalid();
  for (const [path, raw] of entries) {
    tombFileKey(input.tomb, path);
    if (
      [
        HEADER_PATH,
        ROTATION_JOURNAL_PATH,
        MIGRATION_MARKER_PATH,
        SEAL_BOUND_MARKER_PATH,
      ].includes(path)
    )
      invalid();
    validateSeal(raw);
  }
}
/** Complete validation and immutable serialization before altering any live key. */
export function prepareRotationJournal(input: RotationJournalInput): string {
  validate(input);
  const serialized = JSON.stringify({ v: 1, ...input });
  if (
    new TextEncoder().encode(serialized).byteLength > ROTATION_JOURNAL_MAX_BYTES
  )
    invalid();
  return serialized;
}
function decode(tomb: string, raw: string): RotationJournal {
  if (new TextEncoder().encode(raw).byteLength > ROTATION_JOURNAL_MAX_BYTES)
    invalid();
  const value = parseObject(raw);
  if (
    Object.keys(value).length !== 6 ||
    value.v !== 1 ||
    value.tomb !== tomb ||
    !isString(value.token) ||
    !isString(value.previousHeader) ||
    !isString(value.nextHeader) ||
    !isJsonObject(value.files)
  )
    invalid();
  const files: Record<string, string> = {};
  for (const [path, ciphertext] of Object.entries(value.files)) {
    if (!isString(ciphertext)) invalid();
    files[path] = ciphertext;
  }
  const journal: RotationJournal = {
    v: 1,
    tomb,
    token: value.token,
    previousHeader: value.previousHeader,
    nextHeader: value.nextHeader,
    files,
  };
  validate(journal);
  return journal;
}
export function hasPendingRotationJournal(tomb: string): boolean {
  return vfsSeams.readRaw(tombFileKey(tomb, ROTATION_JOURNAL_PATH)) !== null;
}
function assertHeader(journal: RotationJournal): void {
  const current = vfsSeams.readRaw(tombFileKey(journal.tomb, HEADER_PATH));
  if (current !== journal.previousHeader && current !== journal.nextHeader)
    throw new Error("Vault rotation journal does not match the current header");
}
async function rollForward(
  journal: RotationJournal,
  guard: () => void,
): Promise<void> {
  guard();
  assertHeader(journal);
  for (const [path, raw] of Object.entries(journal.files)) {
    guard();
    assertHeader(journal);
    await vfsSeams.writeRaw(tombFileKey(journal.tomb, path), raw);
    guard();
  }
  assertHeader(journal);
  await vfsSeams.writeRaw(
    tombFileKey(journal.tomb, HEADER_PATH),
    journal.nextHeader,
  );
  guard();
  if (
    vfsSeams.readRaw(tombFileKey(journal.tomb, HEADER_PATH)) !==
    journal.nextHeader
  )
    throw new Error("Vault rotation header publication failed");
  await vfsSeams.deleteRaw(tombFileKey(journal.tomb, ROTATION_JOURNAL_PATH));
  guard();
}
/** Caller holds the same-tomb write lock until recovery/commit finishes. */
export async function commitRotationJournal(
  tomb: string,
  serialized: string,
  guard: () => void,
): Promise<void> {
  const journal = decode(tomb, serialized);
  guard();
  if (hasPendingRotationJournal(tomb))
    throw new Error("A vault rotation is already pending");
  if (
    vfsSeams.readRaw(tombFileKey(tomb, HEADER_PATH)) !== journal.previousHeader
  )
    throw new Error("Vault header changed before rotation preparation");
  await vfsSeams.writeRaw(tombFileKey(tomb, ROTATION_JOURNAL_PATH), serialized);
  guard();
  await rollForward(journal, guard);
}

/** Caught I/O failure may restore only this unpublished, still-owned commit. */
export async function rollbackPreparedRotation(
  tomb: string,
  serialized: string,
  originals: ReadonlyMap<string, string>,
  guard: () => void,
): Promise<void> {
  const journal = decode(tomb, serialized);
  if (
    originals.size !== Object.keys(journal.files).length ||
    [...originals.keys()].some((path) => !Object.hasOwn(journal.files, path))
  )
    invalid();
  let bytes = 0;
  for (const raw of originals.values()) {
    validateSeal(raw);
    bytes += new TextEncoder().encode(raw).byteLength;
  }
  if (bytes > ROTATION_JOURNAL_MAX_BYTES) invalid();
  const headerKey = tombFileKey(tomb, HEADER_PATH);
  const journalKey = tombFileKey(tomb, ROTATION_JOURNAL_PATH);
  const check = () => {
    guard();
    if (
      vfsSeams.readRaw(headerKey) !== journal.previousHeader ||
      vfsSeams.readRaw(journalKey) !== serialized
    )
      throw new Error(
        "The original unpublished rotation is no longer current.",
      );
  };
  guard();
  await kvRefresh(headerKey, ROTATION_JOURNAL_MAX_BYTES);
  guard();
  await kvRefresh(journalKey, ROTATION_JOURNAL_MAX_BYTES);
  check();
  for (const [path, original] of originals) {
    const key = tombFileKey(tomb, path);
    await kvRefresh(key, ROTATION_JOURNAL_MAX_BYTES);
    check();
    const current = vfsSeams.readRaw(key);
    if (current === original) continue;
    if (current !== journal.files[path])
      throw new Error("The rotation ciphertext changed before rollback.");
    await vfsSeams.writeRaw(key, original);
    check();
  }
  for (const [path, original] of originals) {
    await kvRefresh(tombFileKey(tomb, path), ROTATION_JOURNAL_MAX_BYTES);
    check();
    if (vfsSeams.readRaw(tombFileKey(tomb, path)) !== original)
      throw new Error("The original rotation ciphertext was not restored.");
  }
  check();
  await vfsSeams.deleteRaw(journalKey);
  guard();
}
/** Recovery requires no admitted decryption key and never opens ciphertext. */
export async function recoverRotationJournal(
  tomb: string,
  guard: () => void,
): Promise<boolean> {
  guard();
  const raw = vfsSeams.readRaw(tombFileKey(tomb, ROTATION_JOURNAL_PATH));
  if (raw === null) return false;
  const journal = decode(tomb, raw);
  await rollForward(journal, guard);
  return true;
}
