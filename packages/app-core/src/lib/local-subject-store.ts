import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { randomString } from "@opensesame/sdk-browser";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-subjects";
const MAX_BYTES = 1_000_000;
const MAX_RECORDS = 4096;
type PairwiseSubject = {
  principalId: string;
  applicationId: string;
  subject: string;
};
function invalid(): never {
  throw new LocalDirectoryError(
    "Local subject storage is invalid or full. Restore a valid vault backup.",
  );
}
function isPrincipal(value: BoundaryValue): value is string {
  return isString(value) && /^local_[0-9a-f-]{36}$/.test(value);
}
function isRecord(value: BoundaryValue): value is PairwiseSubject {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 3 &&
    isPrincipal(value.principalId) &&
    isPrincipal(value.applicationId) &&
    isString(value.subject) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.subject)
  );
}
async function readSubjects(tomb: string): Promise<PairwiseSubject[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES) invalid();
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      Object.keys(value).length !== 2 ||
      value.version !== 1 ||
      !Array.isArray(value.subjects) ||
      value.subjects.length > MAX_RECORDS ||
      !value.subjects.every(isRecord)
    )
      invalid();
    const rows = value.subjects;
    if (
      new Set(rows.map((row) => `${row.principalId}:${row.applicationId}`))
        .size !== rows.length ||
      new Set(rows.map((row) => row.subject)).size !== rows.length
    )
      invalid();
    return rows;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

/**
 * Internal issuer projection. Caller holds the directory/session fence after
 * grant admission. Never derive a subject from a canonical ID or expire the
 * mapping with a grant: fresh consent must retain the same opaque identity.
 * Existing grants acquire a mapping on their next claim, never a legacy sub.
 */
export async function localSubjectUnderLock(
  tomb: string,
  principalId: string,
  applicationId: string,
): Promise<string> {
  if (!isPrincipal(principalId) || !isPrincipal(applicationId)) invalid();
  const subjects = await readSubjects(tomb);
  const found = subjects.find(
    (row) =>
      row.principalId === principalId && row.applicationId === applicationId,
  );
  if (found) return found.subject;
  if (subjects.length >= MAX_RECORDS) invalid();
  const subject = randomString(32);
  if (subjects.some((row) => row.subject === subject)) invalid();
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      subjects: [...subjects, { principalId, applicationId, subject }],
    }),
  );
  if (bytes.length > MAX_BYTES) invalid();
  // Persistence failure must not issue an ephemeral identity or the canonical ID.
  await writeFile(tomb, PATH, bytes);
  return subject;
}
