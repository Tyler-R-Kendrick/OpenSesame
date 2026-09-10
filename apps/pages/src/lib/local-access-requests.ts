import {
  type LocalAccessRequestInput,
  LocalAccessRequestInputSchema,
  type LocalAccessRequestRecord,
} from "@opensesame/contracts";
import { interactionMachine } from "@opensesame/os-domain";
import {
  requireLocalApplicationAdmission,
  withLocalApplicationRequest,
} from "./local-applications.js";
import { readLocalPasskeys, requireLocalPerson } from "./local-credentials.js";
import {
  LocalDirectoryError,
  type LocalMembership,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import {
  authenticateLocalPasskey,
  consumeLocalAuthentication,
} from "./local-passkeys.js";
import {
  currentRequest,
  localDecisionDigest,
  localRequestDigest,
  readLocalRequestRecords,
  requestInteraction,
  writeLocalRequestRecords,
} from "./local-request-store.js";
import {
  type LocalSession,
  withLocalIdentitySession,
} from "./local-sessions.js";
import { tombUnlocked } from "./vfs.js";

type RequestRef = { id: string; version: number; requestDigest: string };
type Decision = RequestRef & {
  principalId: string;
  decision: "approve" | "deny";
};

function unavailable(): never {
  throw new LocalDirectoryError(
    "This local request is unavailable or has changed. Reload before deciding.",
  );
}

function requireRequest(rows: LocalAccessRequestRecord[], ref: RequestRef) {
  const stored = rows.find((item) => item.id === ref.id);
  const row = stored ? currentRequest(stored) : undefined;
  if (
    !row ||
    row.version !== ref.version ||
    row.requestDigest !== ref.requestDigest ||
    Date.now() < row.createdAt
  )
    unavailable();
  return row;
}

/** Creates an actual encrypted request from a genuine requester session. */
export async function createLocalAccessRequest(
  tomb: string,
  session: LocalSession,
  input: LocalAccessRequestInput,
) {
  const request = LocalAccessRequestInputSchema.parse(input);
  return withLocalApplicationRequest(
    tomb,
    session,
    request.applicationId,
    request.redirectUri,
    request.scopes,
    async (admission, assertActive) => {
      const rows = await readLocalRequestRecords(tomb);
      if (rows.length >= 256)
        throw new LocalDirectoryError(
          "Local request capacity reached. Remove settled requests first.",
        );
      const now = Date.now();
      const base = {
        ...request,
        id: crypto.randomUUID(),
        requesterId: session.principalId,
        requesterSessionId: session.id,
        organizationId: admission.organizationId,
        applicationRevision: admission.revision,
        directoryRevision: (await readLocalDirectory(tomb)).revision,
        createdAt: now,
        expiresAt: now + 300_000,
        version: 0,
        status: "pending" as const,
      };
      const row: LocalAccessRequestRecord = {
        ...base,
        requestDigest: await localRequestDigest(base),
      };
      assertActive();
      await writeLocalRequestRecords(tomb, [...rows, row]);
      assertActive();
      return summarize(row);
    },
  );
}

function summarize(row: LocalAccessRequestRecord) {
  return {
    id: row.id,
    version: row.version,
    requestDigest: row.requestDigest,
    requesterId: row.requesterId,
    applicationId: row.applicationId,
    applicationRevision: row.applicationRevision,
    authorizationDigest: row.authorizationDigest,
    organizationId: row.organizationId,
    redirectUri: row.redirectUri,
    scopes: [...row.scopes],
    reason: row.reason,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
    decidedAt: row.decidedAt,
    approvingPrincipalId: row.approval?.principalId ?? null,
  };
}
export type LocalAccessRequest = ReturnType<typeof summarize>;

/** Role eligibility only; callers must also validate the person and application policy. */
export function localRequestMemberMayDecide(
  row: Pick<
    LocalAccessRequestRecord,
    "organizationId" | "requesterId" | "authorizationDigest"
  >,
  member: LocalMembership,
) {
  return (
    member.organizationId === row.organizationId &&
    (member.role === "owner" ||
      member.role === "admin" ||
      (Boolean(row.authorizationDigest) &&
        member.principalId === row.requesterId))
  );
}

/** Custodian display. Identifiers are references, not credentials or private presentations. */
export async function listLocalAccessRequests(
  tomb: string,
): Promise<LocalAccessRequest[]> {
  return withLocalDirectoryLock(tomb, async () => {
    const rows = await readLocalRequestRecords(tomb);
    if (!tombUnlocked(tomb)) unavailable();
    return rows.map((row) => summarize(currentRequest(row)));
  });
}

async function requirePolicy(
  tomb: string,
  row: LocalAccessRequestRecord,
  approverId: string,
) {
  const admission = await requireLocalApplicationAdmission(
    tomb,
    row.requesterId,
    row.applicationId,
    row.redirectUri,
    row.scopes,
  );
  const directory = await readLocalDirectory(tomb);
  if (
    admission.revision !== row.applicationRevision ||
    directory.revision !== row.directoryRevision
  )
    unavailable();
  await requireLocalPerson(tomb, approverId);
  const member = directory.memberships.find(
    (item) =>
      item.organizationId === row.organizationId &&
      item.principalId === approverId,
  );
  if (!member || !localRequestMemberMayDecide(row, member)) unavailable();
  await requireLocalApplicationAdmission(
    tomb,
    approverId,
    row.applicationId,
    row.redirectUri,
    row.scopes,
  );
}

/** Fresh WebAuthn binds the decision, request and approver before the atomic write. */
export async function decideLocalAccessRequest(
  tomb: string,
  decision: Decision,
) {
  if (decision.decision !== "approve" && decision.decision !== "deny")
    unavailable();
  const input = { ...decision };
  const before = await withLocalDirectoryLock(tomb, async () => {
    const row = requireRequest(await readLocalRequestRecords(tomb), input);
    if (row.status !== "pending") unavailable();
    interactionMachine.assertLive(
      requestInteraction(row),
      new Date(Date.now()),
    );
    await requirePolicy(tomb, row, input.principalId);
    return row;
  });
  const digest = await localDecisionDigest(
    before,
    input.principalId,
    input.decision,
  );
  const evidence = await authenticateLocalPasskey(
    tomb,
    input.principalId,
    digest,
  );
  return withLocalDirectoryLock(tomb, async () => {
    consumeLocalAuthentication(evidence, digest);
    const rows = await readLocalRequestRecords(tomb);
    const row = requireRequest(rows, input);
    if (
      row.status !== "pending" ||
      evidence.tomb !== tomb ||
      evidence.principalId !== input.principalId
    )
      unavailable();
    await requirePolicy(tomb, row, input.principalId);
    const approval = {
      principalId: evidence.principalId,
      credentialId: evidence.credentialId,
      credentialCreatedAt: evidence.credentialCreatedAt,
      publicKeyB64: evidence.publicKeyB64,
      authTime: evidence.authTime,
      decisionDigest: digest,
    };
    await requireApprovalKey(tomb, approval);
    const now = new Date(Date.now());
    const interaction = requestInteraction(row);
    const settled =
      input.decision === "approve"
        ? interactionMachine.approve(
            interactionMachine.awaitApproval(
              interaction,
              input.principalId,
              now,
            ),
            {
              approverPrincipalId: input.principalId,
              now,
              proof: {
                mechanism: "webauthn",
                boundDigest: row.requestDigest,
                assurance: "phishing_resistant",
                verifiedAt: new Date(evidence.authTime),
              },
            },
          )
        : interactionMachine.deny(interaction, input.principalId, now);
    const next: LocalAccessRequestRecord = {
      ...row,
      status: input.decision === "approve" ? "approved" : "denied",
      version: settled.version,
      decidedAt: now.getTime(),
      approval,
    };
    await writeLocalRequestRecords(
      tomb,
      rows.map((item) => (item.id === row.id ? next : item)),
    );
    return summarize(next);
  });
}

export async function requireApprovalKey(
  tomb: string,
  approval: NonNullable<LocalAccessRequestRecord["approval"]>,
) {
  const keys = await readLocalPasskeys(tomb);
  if (
    Date.now() < approval.authTime ||
    Date.now() - approval.authTime >= 300_000 ||
    !keys.some(
      (key) =>
        key.principalId === approval.principalId &&
        key.credentialId === approval.credentialId &&
        key.createdAt === approval.credentialCreatedAt &&
        key.publicKeyB64 === approval.publicKeyB64,
    )
  )
    unavailable();
}

/** Consume before effects; a failed effect burns approval and requires a new request. */
export async function consumeLocalAccessRequest<T>(
  tomb: string,
  session: LocalSession,
  ref: RequestRef,
  action: (request: LocalAccessRequest) => Promise<T>,
) {
  const reference = { ...ref };
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const rows = await readLocalRequestRecords(tomb);
      const row = requireRequest(rows, reference);
      if (
        row.status !== "approved" ||
        !row.approval ||
        row.requesterId !== identity.principalId ||
        row.requesterSessionId !== session.id
      )
        unavailable();
      await requirePolicy(tomb, row, row.approval.principalId);
      await requireApprovalKey(tomb, row.approval);
      if (
        (await localDecisionDigest(
          row,
          row.approval.principalId,
          "approve",
        )) !== row.approval.decisionDigest
      )
        unavailable();
      const consumed = interactionMachine.consume(
        requestInteraction(row),
        new Date(Date.now()),
      );
      const next: LocalAccessRequestRecord = {
        ...row,
        status: "consumed",
        version: consumed.version,
        consumedAt: Date.now(),
      };
      assertActive();
      await writeLocalRequestRecords(
        tomb,
        rows.map((item) => (item.id === row.id ? next : item)),
      );
      assertActive();
      return action(summarize(next));
    },
  );
}

/** Custodian withdrawal can only narrow pending authority. */
export async function revokeLocalAccessRequest(tomb: string, ref: RequestRef) {
  const reference = { ...ref };
  return withLocalDirectoryLock(tomb, async () => {
    const rows = await readLocalRequestRecords(tomb);
    const row = requireRequest(rows, reference);
    const revoked = interactionMachine.revoke(
      requestInteraction(row),
      new Date(Date.now()),
    );
    const next: LocalAccessRequestRecord = {
      ...row,
      status: "revoked",
      version: revoked.version,
    };
    await writeLocalRequestRecords(
      tomb,
      rows.map((item) => (item.id === row.id ? next : item)),
    );
    return summarize(next);
  });
}

/** Remove terminal history only; pending or approved authority must first be withdrawn. */
export async function removeSettledLocalAccessRequest(
  tomb: string,
  ref: RequestRef,
) {
  const reference = { ...ref };
  return withLocalDirectoryLock(tomb, async () => {
    const rows = await readLocalRequestRecords(tomb);
    const row = requireRequest(rows, reference);
    if (!interactionMachine.isTerminal(row.status)) unavailable();
    await writeLocalRequestRecords(
      tomb,
      rows.filter((item) => item.id !== row.id),
    );
  });
}
