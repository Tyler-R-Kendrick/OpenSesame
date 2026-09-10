import { sha256Base64Url } from "@opensesame/sdk-browser";
import {
  type LocalAuthorizationRequest,
  localAuthorizationQuery,
  parseLocalAuthorizationRequest,
} from "@opensesame/static-auth";
import {
  type LocalAccessRequest,
  requireApprovalKey,
} from "./local-access-requests.js";
import type { LocalApplicationApproval } from "./local-application-approval.js";
import { LocalDirectoryError } from "./local-directory.js";
import {
  readLocalRequestRecords,
  writeLocalRequestRecords,
} from "./local-request-store.js";

export function localApplicationRequestDigest(
  input: LocalAuthorizationRequest,
) {
  const request = parseLocalAuthorizationRequest(
    localAuthorizationQuery(input),
  );
  return sha256Base64Url(
    JSON.stringify([
      "opensesame:application-request:v1",
      localAuthorizationQuery(request),
    ]),
  );
}

/** Called inside the existing application/session fence, immediately before issuance. */
export async function requireConsumedRequest(
  tomb: string,
  reference: LocalAccessRequest,
  approval: LocalApplicationApproval,
  request: LocalAuthorizationRequest,
) {
  const row = (await readLocalRequestRecords(tomb)).find(
    (entry) => entry.id === reference.id,
  );
  if (
    !row ||
    row.status !== "consumed" ||
    !row.approval ||
    row.version !== reference.version ||
    row.requestDigest !== reference.requestDigest ||
    row.authorizationDigest !==
      (await localApplicationRequestDigest(request)) ||
    row.requesterSessionId !== approval.session.id ||
    row.requesterId !== approval.session.principalId ||
    row.approval.principalId !==
      (approval.approver ?? approval.session).principalId ||
    Date.now() < row.createdAt ||
    Date.now() >= row.expiresAt
  )
    throw new LocalDirectoryError(
      "This consumed approval is no longer available.",
    );
  await requireApprovalKey(tomb, row.approval);
  return row;
}

/** Caller holds the directory/session fence through this durable claim and issuance. */
export async function claimConsumedRequest(
  tomb: string,
  reference: LocalAccessRequest,
  approval: LocalApplicationApproval,
  request: LocalAuthorizationRequest,
) {
  const row = await requireConsumedRequest(tomb, reference, approval, request);
  if (row.codeIssuedAt !== undefined)
    throw new LocalDirectoryError("This approval has already issued a code.");
  const rows = await readLocalRequestRecords(tomb);
  await writeLocalRequestRecords(
    tomb,
    rows.map((entry) =>
      entry.id === row.id ? { ...entry, codeIssuedAt: Date.now() } : entry,
    ),
  );
}
