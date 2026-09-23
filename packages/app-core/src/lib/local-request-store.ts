import {
  type LocalAccessRequestRecord,
  LocalAccessRequestStoreSchema,
} from "@opensesame/contracts";
import { type Interaction, interactionMachine } from "@opensesame/os-domain";
import { sha256Base64Url } from "@opensesame/sdk-browser";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-requests";
const MAX_BYTES = 512_000;

export function localRequestDigest(
  row: Omit<LocalAccessRequestRecord, "requestDigest">,
) {
  return sha256Base64Url(
    JSON.stringify([
      "opensesame:local-access-request:v1",
      row.id,
      row.requesterId,
      row.requesterSessionId,
      row.organizationId,
      row.applicationId,
      row.applicationRevision,
      row.directoryRevision,
      row.redirectUri,
      [...row.scopes].sort(),
      row.reason,
      row.createdAt,
      row.expiresAt,
      ...(row.authorizationDigest
        ? ["application_signin", row.authorizationDigest]
        : []),
    ]),
  );
}

export function localDecisionDigest(
  row: LocalAccessRequestRecord,
  principalId: string,
  decision: "approve" | "deny",
) {
  return sha256Base64Url(
    JSON.stringify([
      "opensesame:local-access-decision:v1",
      row.requestDigest,
      principalId,
      decision,
    ]),
  );
}

export function requestInteraction(row: LocalAccessRequestRecord): Interaction {
  return {
    id: row.id,
    kind: "authorization_request",
    subject: { kind: "authorization_request", subjectId: row.id },
    status: row.status,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt),
    requestDigest: row.requestDigest,
    authorizationDetails: [
      {
        type: "local_application",
        applicationId: row.applicationId,
        scopes: row.scopes,
      },
    ],
    version: row.version,
  };
}

export function currentRequest(
  row: LocalAccessRequestRecord,
): LocalAccessRequestRecord {
  const projected = interactionMachine.maybeExpire(
    requestInteraction(row),
    new Date(Date.now()),
  );
  if (projected.status === "expired")
    return { ...row, status: "expired", version: projected.version };
  return row;
}

/** Internal ledger: callers hold the same cross-tab fence as directory/session writes. */
export async function readLocalRequestRecords(tomb: string) {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError(
        "Local requests exceed their storage limit.",
      );
    const parsed = LocalAccessRequestStoreSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    for (const row of parsed.requests)
      if ((await localRequestDigest(row)) !== row.requestDigest)
        throw new LocalDirectoryError("The local request binding is invalid.");
    return parsed.requests;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

export async function writeLocalRequestRecords(
  tomb: string,
  requests: LocalAccessRequestRecord[],
) {
  const value = LocalAccessRequestStoreSchema.parse({ version: 1, requests });
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Local requests exceed their storage limit.");
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}
