/**
 * Host shared sessions (ADR 0079) — open, grant, revoke, join decide.
 *
 * Join discovery and ask-to-join already live in `join-session.ts`. This
 * module is the operator side plus session detail, so Access can manage a
 * real Host session instead of only the offline vault-session dogfood.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { AccessError, call } from "./access.js";

export type SessionVisibility = "private" | "public";
export type SessionRole = "read" | "write";

export type GrantScope =
  | { kind: "collection"; vaultId: string }
  | { kind: "rows"; vaultId: string; items: string[] };

export type OpenedSession = {
  id: string;
  displayName: string;
  visibility: SessionVisibility;
  operatorPrincipalId: string;
  createdAt: string;
};

export type SessionParticipant = {
  principalId: string;
  role: SessionRole;
  expiresAt: string;
  grantId?: string;
  grantedBy?: string;
  scope?: GrantScope;
};

export type SharedSessionDetail = {
  id: string;
  displayName: string;
  visibility: SessionVisibility;
  operatorPrincipalId: string;
  createdAt: string;
  closedAt: string | null;
  participants: SessionParticipant[];
};

export type SessionGrant = {
  grantId: string;
  principalId: string;
  role: SessionRole;
  expiresAt: string;
  grantedBy: string;
  scope: GrantScope;
};

export type JoinRequestRow = {
  id: string;
  requesterPrincipalId: string;
  note: string | null;
  requestedAt: string;
};

export type GrantInput = {
  subjectPrincipalId?: string;
  scope: GrantScope;
  role: SessionRole;
  expiresAt: string;
};

function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
}

function list(value: BoundaryValue): BoundaryValue[] {
  return Array.isArray(value) ? value : [];
}

function visibilityOf(raw: BoundaryValue): SessionVisibility {
  return raw === "public" ? "public" : "private";
}

function roleOf(raw: BoundaryValue): SessionRole | null {
  return raw === "read" || raw === "write" ? raw : null;
}

function scopeOf(raw: BoundaryValue): GrantScope | null {
  if (!isJsonObject(raw) || !isString(raw.kind) || !isString(raw.vault_id))
    return null;
  if (raw.kind === "collection")
    return { kind: "collection", vaultId: raw.vault_id };
  if (raw.kind === "rows") {
    const items = list(raw.items).filter((entry): entry is string =>
      isString(entry),
    );
    return { kind: "rows", vaultId: raw.vault_id, items };
  }
  return null;
}

function participantOf(value: BoundaryValue): SessionParticipant | null {
  if (!isJsonObject(value) || !isString(value.principal_id)) return null;
  const role = roleOf(value.role);
  if (!role || !isString(value.expires_at)) return null;
  const row: SessionParticipant = {
    principalId: value.principal_id,
    role,
    expiresAt: value.expires_at,
  };
  if (isString(value.grant_id)) row.grantId = value.grant_id;
  if (isString(value.granted_by)) row.grantedBy = value.granted_by;
  const scope = scopeOf(value.scope);
  if (scope) row.scope = scope;
  return row;
}

function grantOf(value: BoundaryValue): SessionGrant | null {
  const row = participantOf(value);
  if (!row?.grantId || !row.grantedBy || !row.scope) return null;
  return {
    grantId: row.grantId,
    principalId: row.principalId,
    role: row.role,
    expiresAt: row.expiresAt,
    grantedBy: row.grantedBy,
    scope: row.scope,
  };
}

function scopeBody(scope: GrantScope): JsonObject {
  if (scope.kind === "collection")
    return { kind: "collection", vault_id: scope.vaultId };
  return {
    kind: "rows",
    vault_id: scope.vaultId,
    items: scope.items,
  };
}

function grantBody(input: GrantInput): JsonObject {
  const body: JsonObject = {
    scope: scopeBody(input.scope),
    role: input.role,
    expires_at: input.expiresAt,
  };
  if (input.subjectPrincipalId)
    body.subject_principal_id = input.subjectPrincipalId;
  return body;
}

async function openSharedSessionDefault(
  displayName: string,
  visibility: SessionVisibility = "private",
): Promise<OpenedSession> {
  const name = displayName.trim();
  if (!name || name.length > 120)
    throw new AccessError(
      422,
      "session_display_name",
      "Name the session in 1 to 120 characters.",
    );
  return call(
    "/shared-sessions",
    {
      method: "POST",
      body: JSON.stringify({ display_name: name, visibility }),
    },
    (body) => {
      if (
        !isJsonObject(body) ||
        !isString(body.id) ||
        !isString(body.display_name) ||
        !isString(body.operator_principal_id) ||
        !isString(body.created_at)
      )
        throw new AccessError(
          502,
          "session_shape",
          "Host returned a bad session.",
        );
      return {
        id: body.id,
        displayName: body.display_name,
        visibility: visibilityOf(body.visibility),
        operatorPrincipalId: body.operator_principal_id,
        createdAt: body.created_at,
      };
    },
  );
}

async function getSharedSessionDefault(
  sessionId: string,
): Promise<SharedSessionDetail> {
  return call(
    `/shared-sessions/${encodeURIComponent(sessionId)}`,
    {},
    (body) => {
      if (
        !isJsonObject(body) ||
        !isString(body.id) ||
        !isString(body.display_name) ||
        !isString(body.operator_principal_id) ||
        !isString(body.created_at)
      )
        throw new AccessError(
          502,
          "session_shape",
          "Host returned a bad session.",
        );
      return {
        id: body.id,
        displayName: body.display_name,
        visibility: visibilityOf(body.visibility),
        operatorPrincipalId: body.operator_principal_id,
        createdAt: body.created_at,
        closedAt: isString(body.closed_at) ? body.closed_at : null,
        participants: list(body.participants)
          .map(participantOf)
          .filter((row): row is SessionParticipant => row !== null),
      };
    },
  );
}

async function grantSharedSessionDefault(
  sessionId: string,
  input: GrantInput,
): Promise<SessionGrant> {
  if (!input.subjectPrincipalId)
    throw new AccessError(
      422,
      "grant_subject",
      "Name the principal this grant is for.",
    );
  return call(
    `/shared-sessions/${encodeURIComponent(sessionId)}/grants`,
    { method: "POST", body: JSON.stringify(grantBody(input)) },
    (body) => {
      const grant = isJsonObject(body) ? grantOf(body.grant) : null;
      if (!grant)
        throw new AccessError(502, "grant_shape", "Host returned a bad grant.");
      return grant;
    },
  );
}

async function revokeSharedSessionGrantDefault(
  sessionId: string,
  grantId: string,
): Promise<void> {
  await call(
    `/shared-sessions/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
    () => null,
  );
}

async function listJoinRequestsDefault(
  sessionId: string,
): Promise<JoinRequestRow[]> {
  return call(
    `/shared-sessions/${encodeURIComponent(sessionId)}/join-requests`,
    {},
    (body) => {
      if (!isJsonObject(body)) return [];
      return list(body.requests)
        .map((entry) => {
          if (
            !isJsonObject(entry) ||
            !isString(entry.id) ||
            !isString(entry.requester_principal_id) ||
            !isString(entry.requested_at)
          )
            return null;
          const row: JoinRequestRow = {
            id: entry.id,
            requesterPrincipalId: entry.requester_principal_id,
            note: isString(entry.note) ? entry.note : null,
            requestedAt: entry.requested_at,
          };
          return row;
        })
        .filter((row): row is JoinRequestRow => row !== null);
    },
  );
}

async function decideJoinRequestDefault(
  sessionId: string,
  requestId: string,
  decision: "admitted" | "refused",
  grant?: GrantInput,
): Promise<{ id: string; decision: string; grant: SessionGrant | null }> {
  const body: JsonObject = { decision };
  if (decision === "admitted") {
    if (!grant)
      throw new AccessError(
        422,
        "decision_shape",
        "Admission needs the grant it mints.",
      );
    body.grant = grantBody({
      scope: grant.scope,
      role: grant.role,
      expiresAt: grant.expiresAt,
    });
  }
  return call(
    `/shared-sessions/${encodeURIComponent(sessionId)}/join-requests/${encodeURIComponent(requestId)}/decide`,
    { method: "POST", body: JSON.stringify(body) },
    (raw) => {
      if (!isJsonObject(raw) || !isString(raw.id) || !isString(raw.decision))
        throw new AccessError(
          502,
          "decision_shape",
          "Host returned a bad join decision.",
        );
      return {
        id: raw.id,
        decision: raw.decision,
        grant: grantOf(raw.grant),
      };
    },
  );
}

export const sharedSessionSeams = {
  openSharedSession: openSharedSessionDefault,
  getSharedSession: getSharedSessionDefault,
  grantSharedSession: grantSharedSessionDefault,
  revokeSharedSessionGrant: revokeSharedSessionGrantDefault,
  listJoinRequests: listJoinRequestsDefault,
  decideJoinRequest: decideJoinRequestDefault,
};

export function openSharedSession(
  displayName: string,
  visibility?: SessionVisibility,
): Promise<OpenedSession> {
  return sharedSessionSeams.openSharedSession(displayName, visibility);
}

export function getSharedSession(
  sessionId: string,
): Promise<SharedSessionDetail> {
  return sharedSessionSeams.getSharedSession(sessionId);
}

export function grantSharedSession(
  sessionId: string,
  input: GrantInput,
): Promise<SessionGrant> {
  return sharedSessionSeams.grantSharedSession(sessionId, input);
}

export function revokeSharedSessionGrant(
  sessionId: string,
  grantId: string,
): Promise<void> {
  return sharedSessionSeams.revokeSharedSessionGrant(sessionId, grantId);
}

export function listJoinRequests(sessionId: string): Promise<JoinRequestRow[]> {
  return sharedSessionSeams.listJoinRequests(sessionId);
}

export function decideJoinRequest(
  sessionId: string,
  requestId: string,
  decision: "admitted" | "refused",
  grant?: GrantInput,
): Promise<{ id: string; decision: string; grant: SessionGrant | null }> {
  return sharedSessionSeams.decideJoinRequest(
    sessionId,
    requestId,
    decision,
    grant,
  );
}
