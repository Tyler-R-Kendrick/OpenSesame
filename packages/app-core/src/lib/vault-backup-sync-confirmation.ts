/** A successful HTTP exchange is not yet a confirmed Git backup write. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { readBoundedObject } from "./bounded-response.js";

export type BackupWriteConfirmation = { commitSha: string };

/** Git object IDs are complete SHA-1 or SHA-256 values, never the null object. */
export function confirmedBackupCommit(value: BoundaryValue): string {
  if (
    !isString(value) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ||
    /^0+$/.test(value)
  )
    throw new Error("Backup write did not confirm a commit.");
  return value;
}

/** Preserve the original response bounds; provider bodies never become errors. */
export async function readBackupWriteConfirmation(
  response: Response,
): Promise<BackupWriteConfirmation> {
  const failure = new Error(
    response.ok
      ? "Backup write returned an invalid confirmation."
      : `Backup write failed (${response.status})`,
  );
  const payload = await readBoundedObject(response, 65536, 30_000).catch(() => {
    throw failure;
  });
  if (!response.ok) throw failure;
  if (
    (payload.ok !== undefined && payload.ok !== true) ||
    (payload.error !== undefined && payload.error !== null)
  )
    throw new Error("Backup provider refused the write.");
  return { commitSha: confirmedBackupCommit(payload.commitSha) };
}
