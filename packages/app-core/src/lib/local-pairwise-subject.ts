import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-pairwise-subjects";
const MAX_BYTES = 1_000_000;
const MAX_SUBJECTS = 4096;
type PairwiseSubject = {
  principalId: string;
  applicationId: string;
  subject: string;
};

function unavailable(): never {
  throw new LocalDirectoryError(
    "Local pairwise subject storage is unavailable.",
  );
}

function localId(value: BoundaryValue): value is string {
  return isString(value) && /^local_[0-9a-f-]{36}$/.test(value);
}

function isSubject(value: BoundaryValue): value is PairwiseSubject {
  return (
    isJsonObject(value) &&
    localId(value.principalId) &&
    localId(value.applicationId) &&
    isString(value.subject) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.subject,
    )
  );
}

async function readSubjects(tomb: string): Promise<PairwiseSubject[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(tomb, PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
  if (bytes.length > MAX_BYTES) unavailable();
  const stored: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !isJsonObject(stored) ||
    stored.version !== 1 ||
    !Array.isArray(stored.subjects) ||
    stored.subjects.length > MAX_SUBJECTS ||
    !stored.subjects.every(isSubject)
  )
    unavailable();
  const records = stored.subjects;
  if (
    new Set(records.map((row) => `${row.principalId}:${row.applicationId}`))
      .size !== records.length ||
    new Set(records.map((row) => row.subject)).size !== records.length
  )
    unavailable();
  return records;
}

/**
 * The caller holds the local directory/session fence and has authorized the
 * exact application. Mappings survive session/grant expiry in encrypted VFS;
 * canonical IDs remain internal and never become downstream claims.
 */
export async function localPairwiseSubjectInDirectoryFence(
  tomb: string,
  principalId: string,
  applicationId: string,
): Promise<string> {
  if (!localId(principalId) || !localId(applicationId)) unavailable();
  const records = await readSubjects(tomb);
  const existing = records.find(
    (row) =>
      row.principalId === principalId && row.applicationId === applicationId,
  );
  if (existing) return existing.subject;
  if (records.length >= MAX_SUBJECTS) unavailable();
  const subject = crypto.randomUUID();
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      subjects: [...records, { principalId, applicationId, subject }],
    }),
  );
  if (bytes.length > MAX_BYTES) unavailable();
  await writeFile(tomb, PATH, bytes);
  return subject;
}
