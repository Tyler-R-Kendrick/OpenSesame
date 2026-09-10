import { isString } from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import type { LocalAccessRequest } from "./local-access-requests.js";
import {
  type LocalApplicationApproval,
  withLocalApplicationApproval,
} from "./local-application-approval.js";
import { LocalDirectoryError } from "./local-directory.js";
import {
  type LocalGrantRecord,
  readLocalGrantRecords,
  writeLocalGrantRecords,
} from "./local-grant-store.js";
import { claimConsumedRequest } from "./local-request-issuance.js";
import {
  type LocalSession,
  withLocalIdentitySession,
} from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";

export type { LocalAuthorizationRequest } from "@opensesame/static-auth";
/** Object capability: serialization loses authority. Not a network OAuth token. */
export type LocalApplicationGrant = Readonly<{
  id: string;
  applicationId: string;
  expiresAt: number;
}>;
type PendingCode = {
  tomb: string;
  approval: LocalApplicationApproval;
  request: LocalAuthorizationRequest;
  applicationRevision: number;
  issuedAt: number;
  expiresAt: number;
};
let pending = new Map<string, PendingCode>();
let presentations = new WeakMap<
  LocalApplicationGrant,
  LocalApplicationApproval & {
    tomb: string;
    request: LocalAuthorizationRequest;
  }
>();
vaultStore.onLock(() => {
  pending = new Map();
  presentations = new WeakMap();
});
function refused(): never {
  throw new LocalDirectoryError(
    "This application authorization is unavailable. Start a new sign-in.",
  );
}
function nonce(value: string): boolean {
  return isString(value) && /^[A-Za-z0-9_-]{22,128}$/.test(value);
}
function validateRequest(request: LocalAuthorizationRequest) {
  if (
    !isString(request.applicationId) ||
    request.applicationId.length > 42 ||
    !isString(request.redirectUri) ||
    request.redirectUri.length > 2048 ||
    !Array.isArray(request.scopes) ||
    request.scopes.length > 32 ||
    !request.scopes.every((scope) => isString(scope) && scope.length <= 64) ||
    !nonce(request.state) ||
    !nonce(request.nonce) ||
    request.codeChallengeMethod !== "S256" ||
    !isString(request.codeChallenge) ||
    !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
  )
    refused();
}

/** Issues only from a consumed, passkey-bound request; missing references fail closed. */
export async function approveLocalApplication(
  tomb: string,
  session: LocalSession,
  input: LocalAuthorizationRequest,
  expectedRequest?: LocalAccessRequest,
) {
  if (session.authentication !== "passkey") refused();
  return approve(tomb, { session }, input, expectedRequest);
}

/** Requires a consumed human approval bound to this agent, application and transaction. */
export async function approveLocalAgentApplication(
  tomb: string,
  approver: LocalSession,
  agent: LocalSession,
  input: LocalAuthorizationRequest,
  expectedRequest?: LocalAccessRequest,
) {
  if (
    approver.authentication !== "passkey" ||
    agent.authentication !== "agent_key" ||
    Date.now() < approver.authTime ||
    Date.now() - approver.authTime >= 300_000
  )
    refused();
  return approve(tomb, { session: agent, approver }, input, expectedRequest);
}

async function approve(
  tomb: string,
  approval: LocalApplicationApproval,
  input: LocalAuthorizationRequest,
  expectedRequest?: LocalAccessRequest,
) {
  if (!expectedRequest) refused();
  validateRequest(input);
  const request = structuredClone(input);
  const expected = { ...expectedRequest };
  const queue = pending;
  return withLocalApplicationApproval(
    tomb,
    approval,
    request,
    async (admission, assertActive) => {
      if (admission.revision !== expected.applicationRevision) refused();
      const now = Date.now();
      for (const [key, code] of queue)
        if (code.expiresAt <= now || code.issuedAt > now) queue.delete(key);
      if (queue.size >= 128)
        throw new LocalDirectoryError(
          "Too many pending authorizations. Wait for an existing request to expire.",
        );
      const code = randomString(32);
      const digest = await sha256Base64Url(code);
      await claimConsumedRequest(tomb, expected, approval, request);
      if (queue !== pending) refused();
      assertActive();
      if (
        approval.approver &&
        Date.now() - approval.approver.authTime >= 300_000
      )
        refused();
      if (queue.size >= 128) refused();
      const expiresAt = Math.min(
        now + 120_000,
        approval.session.expiresAt,
        approval.approver?.expiresAt ?? approval.session.expiresAt,
      );
      queue.set(digest, {
        tomb,
        approval,
        request,
        applicationRevision: admission.revision,
        issuedAt: now,
        expiresAt,
      });
      return {
        code,
        state: request.state,
        expiresAt,
      };
    },
  );
}

/** PKCE redemption; failed persistence burns the code and never returns authority. */
export async function redeemLocalApplicationCode(
  tomb: string,
  supplied: {
    code: string;
    applicationId: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<LocalApplicationGrant> {
  const input = {
    code: supplied.code,
    codeVerifier: supplied.codeVerifier,
    applicationId: supplied.applicationId,
    redirectUri: supplied.redirectUri,
  };
  if (
    !isString(input.code) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.code) ||
    !isString(input.codeVerifier) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
  )
    refused();
  const digest = await sha256Base64Url(input.code);
  const queue = pending;
  const code = queue.get(digest);
  if (
    !code ||
    code.tomb !== tomb ||
    code.request.applicationId !== input.applicationId ||
    code.request.redirectUri !== input.redirectUri ||
    (await sha256Base64Url(input.codeVerifier)) !== code.request.codeChallenge
  )
    refused();
  return withLocalApplicationApproval(
    tomb,
    code.approval,
    code.request,
    async (admission, assertActive) => {
      const now = Date.now();
      if (
        queue !== pending ||
        queue.get(digest) !== code ||
        code.issuedAt > now ||
        code.expiresAt <= now ||
        admission.revision !== code.applicationRevision
      )
        refused();
      queue.delete(digest);
      const active = presentations;
      const record: LocalGrantRecord = {
        id: crypto.randomUUID(),
        principalId: code.approval.session.principalId,
        sessionId: code.approval.session.id,
        applicationId: admission.applicationId,
        organizationId: admission.organizationId,
        applicationRevision: admission.revision,
        redirectUri: admission.redirectUri,
        scopes: admission.scopes,
        nonce: code.request.nonce,
        issuedAt: now,
        expiresAt: Math.min(
          code.approval.session.expiresAt,
          code.approval.approver?.expiresAt ?? code.approval.session.expiresAt,
        ),
      };
      if (code.approval.approver)
        record.approval = {
          principalId: code.approval.approver.principalId,
          sessionId: code.approval.approver.id,
        };
      const records = (await readLocalGrantRecords(tomb)).filter(
        (row) => row.expiresAt > now,
      );
      await writeLocalGrantRecords(tomb, [...records, record]);
      if (active !== presentations) refused();
      assertActive();
      const grant = Object.freeze({
        id: record.id,
        applicationId: record.applicationId,
        expiresAt: record.expiresAt,
      });
      active.set(grant, { tomb, ...code.approval, request: code.request });
      return grant;
    },
  );
}

/** Every protected operation supplies its own exact application and scope requirement. */
export async function withLocalApplicationGrant<T>(
  tomb: string,
  grant: LocalApplicationGrant,
  applicationId: string,
  scopes: string[],
  action: (identity: Readonly<LocalGrantRecord>) => Promise<T>,
): Promise<T> {
  if (!Array.isArray(scopes) || scopes.length > 32 || !scopes.every(isString))
    refused();
  const requiredScopes = [...scopes];
  const presentation = presentations.get(grant);
  if (
    !presentation ||
    presentation.tomb !== tomb ||
    grant.applicationId !== applicationId
  )
    refused();
  return withLocalApplicationApproval(
    tomb,
    presentation,
    presentation.request,
    async (admission, assertActive) => {
      const record = (await readLocalGrantRecords(tomb)).find(
        (row) => row.id === grant.id,
      );
      if (
        !record ||
        record.sessionId !== presentation.session.id ||
        record.principalId !== presentation.session.principalId ||
        record.applicationId !== applicationId ||
        record.issuedAt > Date.now() ||
        record.expiresAt <= Date.now() ||
        !requiredScopes.every((scope) => record.scopes.includes(scope)) ||
        !matchesApproval(record, presentation) ||
        !matchesAdmission(record, admission, grant.expiresAt) ||
        presentations.get(grant) !== presentation
      )
        refused();
      if (admission.revision !== record.applicationRevision) refused();
      assertActive();
      return action(Object.freeze({ ...record, scopes: [...record.scopes] }));
    },
  );
}

function matchesAdmission(
  record: LocalGrantRecord,
  admission: Pick<
    LocalGrantRecord,
    "organizationId" | "redirectUri" | "scopes"
  >,
  expiresAt: number,
): boolean {
  return (
    record.organizationId === admission.organizationId &&
    record.expiresAt <= expiresAt &&
    record.redirectUri === admission.redirectUri &&
    record.scopes.length === admission.scopes.length &&
    record.scopes.every((scope) => admission.scopes.includes(scope))
  );
}

function matchesApproval(
  record: LocalGrantRecord,
  approval: LocalApplicationApproval,
): boolean {
  if (!approval.approver) return record.approval === undefined;
  return (
    record.approval?.principalId === approval.approver.principalId &&
    record.approval.sessionId === approval.approver.id
  );
}

/** Subjects and the approving human may inspect or revoke their own grants. */
export async function listLocalApplicationGrants(
  tomb: string,
  session: LocalSession,
) {
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const records = await readLocalGrantRecords(tomb);
      assertActive();
      return records.filter(
        (row) => mayRevokeGrant(row, identity) && row.expiresAt > Date.now(),
      );
    },
  );
}
export async function revokeLocalApplicationGrant(
  tomb: string,
  session: LocalSession,
  id: string,
): Promise<void> {
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const records = await readLocalGrantRecords(tomb);
      assertActive();
      const record = records.find(
        (row) => row.id === id && mayRevokeGrant(row, identity),
      );
      if (!record) refused();
      await writeLocalGrantRecords(
        tomb,
        records.filter((row) => row.id !== id),
      );
    },
  );
}

function mayRevokeGrant(
  record: LocalGrantRecord,
  identity: LocalSession,
): boolean {
  return (
    record.principalId === identity.principalId ||
    (identity.authentication === "passkey" &&
      record.approval?.principalId === identity.principalId)
  );
}
