import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Access screen client (Host plane) — the PAM surfaces that had no UI.
 *
 * Three existing Host APIs, bound read/decide only (ADR 0054):
 *
 * - the relay authorization inbox, where a human approves or denies a relayed
 *   execution and consent binds to the request digest (ADR 0046);
 * - task runs: list, inspect the immutable ceiling against what is held, and
 *   terminate (ADR 0019);
 * - claimable delegation offers (ADR 0044).
 *
 * Nothing here ever receives a credential — the APIs do not expose them.
 */

import { hostBase, hostFetch } from "./identity.js";

export type RelayRequest = {
  id: string;
  delegationId: string;
  connectionId: string;
  operation: string;
  resource: string;
  /** Frozen ask, as submitted. Rendered pretty-printed, never executed here. */
  parameters: BoundaryValue;
  requestDigest: string;
  state: string;
};

export type RelayDecision = {
  id: string;
  state: string;
};

export type TaskRun = {
  taskRunId: string;
  stateVersion: number;
  status: string;
  principalId: string;
};

export type TaskDetail = TaskRun & {
  /** Host-serialised capability sets; the section reads both shapes. */
  capabilityCeiling: BoundaryValue;
  currentCapabilities: BoundaryValue;
};

export type DelegationOfferItem = {
  id: string;
  connectionId: string;
  providerId: string;
  displayName: string;
  actions: string[];
  resources: string[];
  expiresInSeconds: number;
  executionMode: string;
  required: boolean;
  dependencies: string[];
};

export type DelegationOffer = {
  id: string;
  state: string;
  manifestDigest: string;
  expiresAt: string;
  items: DelegationOfferItem[];
};

export type Delegation = {
  id: string;
  offerId: string;
  connectionId: string;
  claimantSubject: string;
  grantId: string;
  executionMode: string;
  actions: string[];
  resources: string[];
  expiresAt: string;
  revokedAt: string | null;
};

export class AccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

/* ------------------------------------------------------------- transport */

function base(): string {
  return hostBase();
}

function plainWords(status: number, detail: string | null): string {
  if (detail) return detail;
  if (status === 401 || status === 403) {
    return "The Host refused this user session. Reconnect to Identity and try again.";
  }
  if (status === 404) {
    return "The Host does not know that id — it may already be gone.";
  }
  if (status === 409) {
    return "The Host reports a state conflict — the list moved under you. Reload and try again.";
  }
  if (status === 503) {
    return `The Host at ${base()} could not authorize this user session.`;
  }
  return `The Host answered ${status}. Check the Host logs at ${base()}.`;
}

async function call<T>(
  path: string,
  init: RequestInit,
  map: (body: BoundaryValue) => T,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let res: Response;
  try {
    res = await hostFetch(`/api/v1${path}`, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new AccessError(
      0,
      "unreachable",
      `Host API unreachable at ${base()}. Start the Host, or point at a running one under Settings.`,
    );
  }

  if (!res.ok) {
    const body = obj(await res.json().catch(() => null));
    const code = isString(body.error) ? body.error : "unknown_error";
    const detail = isString(body.detail)
      ? body.detail
      : isString(body.hint)
        ? body.hint
        : null;
    throw new AccessError(res.status, code, plainWords(res.status, detail));
  }
  return map(await res.json());
}

/* ----------------------------------------------------------- wire mapping */

function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
}

function list(value: BoundaryValue): BoundaryValue[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: BoundaryValue): string[] {
  return list(value).filter((entry): entry is string => isString(entry));
}

function toRelayRequest(value: BoundaryValue): RelayRequest {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    delegationId: String(raw.delegation_id ?? ""),
    connectionId: String(raw.connection_id ?? ""),
    operation: String(raw.operation ?? ""),
    resource: String(raw.resource ?? ""),
    parameters: raw.parameters ?? null,
    requestDigest: String(raw.request_digest ?? ""),
    state: String(raw.state ?? ""),
  };
}

function toTaskRun(value: BoundaryValue): TaskRun {
  const raw = obj(value);
  return {
    taskRunId: String(raw.task_run_id ?? ""),
    stateVersion: isNumber(raw.state_version) ? raw.state_version : 0,
    status: String(raw.status ?? "unknown"),
    principalId: String(raw.principal_id ?? ""),
  };
}

function toOfferItem(value: BoundaryValue): DelegationOfferItem {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    connectionId: String(raw.connection_id ?? ""),
    providerId: String(raw.provider_id ?? ""),
    displayName: String(raw.display_name ?? ""),
    actions: strings(raw.actions),
    resources: strings(raw.resources),
    expiresInSeconds: isNumber(raw.expires_in_seconds)
      ? raw.expires_in_seconds
      : 0,
    executionMode: String(raw.execution_mode ?? "broker"),
    required: Boolean(raw.required),
    dependencies: strings(raw.dependencies),
  };
}

function toOffer(value: BoundaryValue): DelegationOffer {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    state: String(raw.state ?? ""),
    manifestDigest: String(raw.manifest_digest ?? ""),
    expiresAt: String(raw.expires_at ?? ""),
    items: list(raw.items).map(toOfferItem),
  };
}

function toDelegation(value: BoundaryValue): Delegation {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    offerId: String(raw.offer_id ?? ""),
    connectionId: String(raw.connection_id ?? ""),
    claimantSubject: String(raw.claimant_subject ?? ""),
    grantId: String(raw.grant_id ?? ""),
    executionMode: String(raw.execution_mode ?? "broker"),
    actions: strings(raw.actions),
    resources: strings(raw.resources),
    expiresAt: String(raw.expires_at ?? ""),
    revokedAt: isString(raw.revoked_at) ? raw.revoked_at : null,
  };
}

/* --------------------------------------------------------------- requests */

/** The holder's approval inbox: requests parked in front of this principal. */
function listRelayRequestsDefault(): Promise<RelayRequest[]> {
  return call("/relay/requests/pending", {}, (body) =>
    list(obj(body).requests).map(toRelayRequest),
  );
}

async function decide(
  id: string,
  requestDigest: string,
  verdict: "approve" | "deny",
): Promise<RelayDecision> {
  try {
    return await call(
      `/relay/requests/${encodeURIComponent(id)}/${verdict}`,
      {
        method: "POST",
        body: JSON.stringify({ request_digest: requestDigest }),
      },
      (body) => {
        const raw = obj(body);
        return { id: String(raw.id ?? id), state: String(raw.state ?? "") };
      },
    );
  } catch (error) {
    // Wrong digest, lapsed, or already decided all answer 404 — by design the
    // server will not say which, so neither do we.
    if (error instanceof AccessError && error.status === 404) {
      throw new AccessError(
        404,
        "not_found",
        "Already decided or lapsed — someone else got there, or the request expired. Reload the inbox.",
      );
    }
    throw error;
  }
}

function approveRelayRequestDefault(
  id: string,
  requestDigest: string,
): Promise<RelayDecision> {
  return decide(id, requestDigest, "approve");
}

function denyRelayRequestDefault(
  id: string,
  requestDigest: string,
): Promise<RelayDecision> {
  return decide(id, requestDigest, "deny");
}

function listTasksDefault(): Promise<TaskRun[]> {
  return call("/tasks", {}, (body) => list(obj(body).tasks).map(toTaskRun));
}

function getTaskDefault(id: string): Promise<TaskDetail> {
  return call(`/tasks/${encodeURIComponent(id)}`, {}, (body) => {
    const raw = obj(body);
    return {
      ...toTaskRun(raw),
      capabilityCeiling: raw.capability_ceiling ?? null,
      currentCapabilities: raw.current_capabilities ?? null,
    };
  });
}

function terminateTaskDefault(
  id: string,
  expectedStateVersion?: number,
): Promise<TaskRun> {
  return call(
    `/tasks/${encodeURIComponent(id)}/terminate`,
    {
      method: "POST",
      body: JSON.stringify(
        expectedStateVersion === undefined
          ? {}
          : { expected_state_version: expectedStateVersion },
      ),
    },
    toTaskRun,
  );
}

/** Offers this principal minted; claiming is gated server-side per offer. */
function listDelegationOffersDefault(): Promise<DelegationOffer[]> {
  return call("/delegations/offers", {}, (body) =>
    list(obj(body).offers).map(toOffer),
  );
}

function claimDelegationDefault(body: {
  claimToken: string;
  userCode: string;
  acceptedItemIds: string[];
}): Promise<Delegation[]> {
  return call(
    "/delegations/claim",
    {
      method: "POST",
      body: JSON.stringify({
        claim_token: body.claimToken,
        user_code: body.userCode,
        accepted_item_ids: body.acceptedItemIds,
      }),
    },
    (payload) => list(obj(payload).delegations).map(toDelegation),
  );
}

export const accessSeams = {
  listRelayRequests: listRelayRequestsDefault,
  approveRelayRequest: approveRelayRequestDefault,
  denyRelayRequest: denyRelayRequestDefault,
  listTasks: listTasksDefault,
  getTask: getTaskDefault,
  terminateTask: terminateTaskDefault,
  listDelegationOffers: listDelegationOffersDefault,
  claimDelegation: claimDelegationDefault,
};

export function listRelayRequests(): Promise<RelayRequest[]> {
  return accessSeams.listRelayRequests();
}
export function approveRelayRequest(
  ...args: Parameters<typeof approveRelayRequestDefault>
): ReturnType<typeof approveRelayRequestDefault> {
  return accessSeams.approveRelayRequest(...args);
}
export function denyRelayRequest(
  ...args: Parameters<typeof denyRelayRequestDefault>
): ReturnType<typeof denyRelayRequestDefault> {
  return accessSeams.denyRelayRequest(...args);
}
export function listTasks(): Promise<TaskRun[]> {
  return accessSeams.listTasks();
}
export function getTask(id: string): Promise<TaskDetail> {
  return accessSeams.getTask(id);
}
export function terminateTask(
  ...args: Parameters<typeof terminateTaskDefault>
): ReturnType<typeof terminateTaskDefault> {
  return accessSeams.terminateTask(...args);
}
export function listDelegationOffers(): Promise<DelegationOffer[]> {
  return accessSeams.listDelegationOffers();
}
export function claimDelegation(
  ...args: Parameters<typeof claimDelegationDefault>
): ReturnType<typeof claimDelegationDefault> {
  return accessSeams.claimDelegation(...args);
}
