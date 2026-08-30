import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Directory client (Identity plane) — the people/providers/orgs reads and
 * writes behind the Identity screen (ADR 0060).
 *
 * Everything here binds an existing control-plane route through
 * `identityFetch`, with the same caller identity as the rest of Pages:
 *
 * - the principal itself and its linked external identities
 *   (`/v1/principals/me`, `/v1/principals/identities`);
 * - owner-fenced OAuth client CRUD (`/v1/oauth/clients`) — the "service
 *   accounts that aren't people" surface;
 * - organization membership management (`/v1/organizations/:id/members`,
 *   owner-only) and organization creation;
 * - device approval (`/v1/device/approve`) — the control plane holds the
 *   operator token and proxies to the Host.
 *
 * Nothing here ever receives a credential. Rotating an OAuth client mints a
 * new client id server-side and revokes the old one — the client id is all
 * the response carries, so it is all this screen can show.
 */

import { identityBase, identityFetch } from "./identity.js";

export type DirectoryPrincipal = {
  id: string;
  state: string;
  assurance: string;
  createdAt: string;
  verifiedAt?: string;
  version: number;
};

export type LinkedIdentity = {
  id: string;
  kind: string;
  issuer: string;
  displayHint?: string;
  assurance: string;
  linkedAt?: string;
};

export type OAuthClient = {
  id: string;
  displayName: string;
  admissionMode: string;
  state: string;
  redirectUris: string[];
  sectorIdentifier: string;
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  createdAt: string;
  updatedAt: string;
};

export type OrgMember = {
  organizationId: string;
  principalId: string;
  role: string;
  createdAt: string;
};

export type CreatedOrganization = {
  id: string;
  slug: string;
  displayName: string;
  state: string;
  role: string;
  ssoIssuer?: string;
  samlIssuer?: string;
  createdAt: string;
};

/**
 * What `CreateOAuthClientRequestSchema` requires; every other field takes the
 * server's default (grant/response types, auth method, scopes, admission).
 */
export type CreateOAuthClientInput = {
  displayName: string;
  redirectUris: string[];
  sectorIdentifier: string;
};

export type CreateOrganizationInput = {
  slug: string;
  displayName: string;
  ssoIssuer?: string;
};

/** The control plane's proxy answer wraps the Host's status; ok is all we show. */
export type DeviceApproval = {
  ok: boolean;
  status: number;
};

export class DirectoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryError";
  }
}

/* ------------------------------------------------------------- transport */

function plainWords(status: number, detail: string | null): string {
  if (detail) return detail;
  if (status === 401) {
    return "This needs a signed-in session, and yours was refused. Sign in again and retry.";
  }
  if (status === 403) {
    return "Only the owner can do that — your role on this resource does not reach it.";
  }
  if (status === 404) {
    return "Identity does not know that id — it may already be gone. Reload and try again.";
  }
  if (status === 409) {
    return "Identity reports a conflict — the list moved under you. Reload and try again.";
  }
  return `Identity answered ${status}. Check the Identity logs at ${identityBase()}.`;
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
    res = await identityFetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new DirectoryError(
      0,
      "unreachable",
      `Identity API unreachable at ${identityBase()}. Start it, or point at a running one under Settings.`,
    );
  }

  if (!res.ok) {
    const body = obj(await res.json().catch(() => null));
    const code = isString(body.error) ? body.error : "unknown_error";
    const detail = isString(body.message)
      ? body.message
      : isString(body.hint)
        ? body.hint
        : null;
    throw new DirectoryError(res.status, code, plainWords(res.status, detail));
  }
  // 204 (member removal) carries no body; every other success is JSON.
  if (res.status === 204) return map(null);
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

function optional(value: BoundaryValue): string | undefined {
  return isString(value) ? value : undefined;
}

function toPrincipal(value: BoundaryValue): DirectoryPrincipal {
  const raw = obj(value);
  const verifiedAt = optional(raw.verifiedAt);
  return {
    id: String(raw.id ?? ""),
    state: String(raw.state ?? ""),
    assurance: String(raw.assurance ?? ""),
    createdAt: String(raw.createdAt ?? ""),
    ...(verifiedAt !== undefined ? { verifiedAt } : undefined),
    version: isNumber(raw.version) ? raw.version : 0,
  };
}

function toLinkedIdentity(value: BoundaryValue): LinkedIdentity {
  const raw = obj(value);
  const displayHint = optional(raw.displayHint);
  const linkedAt = optional(raw.linkedAt);
  return {
    id: String(raw.id ?? ""),
    kind: String(raw.kind ?? ""),
    issuer: String(raw.issuer ?? ""),
    ...(displayHint !== undefined ? { displayHint } : undefined),
    assurance: String(raw.assurance ?? ""),
    ...(linkedAt !== undefined ? { linkedAt } : undefined),
  };
}

function toOAuthClient(value: BoundaryValue): OAuthClient {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    displayName: String(raw.displayName ?? ""),
    admissionMode: String(raw.admissionMode ?? ""),
    state: String(raw.state ?? ""),
    redirectUris: strings(raw.redirectUris),
    sectorIdentifier: String(raw.sectorIdentifier ?? ""),
    tokenEndpointAuthMethod: String(raw.tokenEndpointAuthMethod ?? ""),
    allowedScopes: strings(raw.allowedScopes),
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

function toOrgMember(value: BoundaryValue): OrgMember {
  const raw = obj(value);
  return {
    organizationId: String(raw.organizationId ?? ""),
    principalId: String(raw.principalId ?? ""),
    role: String(raw.role ?? "member"),
    createdAt: String(raw.createdAt ?? ""),
  };
}

function toCreatedOrganization(value: BoundaryValue): CreatedOrganization {
  const raw = obj(value);
  const ssoIssuer = optional(raw.ssoIssuer);
  const samlIssuer = optional(raw.samlIssuer);
  return {
    id: String(raw.id ?? ""),
    slug: String(raw.slug ?? ""),
    displayName: String(raw.displayName ?? ""),
    state: String(raw.state ?? ""),
    role: String(raw.role ?? ""),
    ...(ssoIssuer !== undefined ? { ssoIssuer } : undefined),
    ...(samlIssuer !== undefined ? { samlIssuer } : undefined),
    createdAt: String(raw.createdAt ?? ""),
  };
}

/* -------------------------------------------------------------- endpoints */

function getMeDefault(): Promise<DirectoryPrincipal> {
  return call("/v1/principals/me", {}, toPrincipal);
}

function listLinkedIdentitiesDefault(): Promise<LinkedIdentity[]> {
  return call("/v1/principals/identities", {}, (body) =>
    list(obj(body).identities).map(toLinkedIdentity),
  );
}

async function unlinkIdentityDefault(id: string): Promise<void> {
  await call(
    `/v1/principals/identities/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

function listOAuthClientsDefault(): Promise<OAuthClient[]> {
  return call("/v1/oauth/clients", {}, (body) =>
    list(obj(body).clients).map(toOAuthClient),
  );
}

function createOAuthClientDefault(
  input: CreateOAuthClientInput,
): Promise<OAuthClient> {
  return call(
    "/v1/oauth/clients",
    {
      method: "POST",
      body: JSON.stringify({
        displayName: input.displayName,
        redirectUris: input.redirectUris,
        sectorIdentifier: input.sectorIdentifier,
      }),
    },
    toOAuthClient,
  );
}

/**
 * Rotation is server-side: the old client id is revoked and a NEW client id is
 * minted in its place. The response carries that record and nothing else —
 * there is no secret to hand back.
 */
function rotateOAuthClientDefault(id: string): Promise<OAuthClient> {
  return call(
    `/v1/oauth/clients/${encodeURIComponent(id)}/rotate`,
    { method: "POST", body: "{}" },
    toOAuthClient,
  );
}

function revokeOAuthClientDefault(id: string): Promise<OAuthClient> {
  return call(
    `/v1/oauth/clients/${encodeURIComponent(id)}/revoke`,
    { method: "POST", body: "{}" },
    toOAuthClient,
  );
}

function listOrgMembersDefault(orgId: string): Promise<OrgMember[]> {
  return call(
    `/v1/organizations/${encodeURIComponent(orgId)}/members`,
    {},
    (body) => list(obj(body).members).map(toOrgMember),
  );
}

function addOrgMemberDefault(
  orgId: string,
  principalId: string,
  role: string,
): Promise<OrgMember> {
  return call(
    `/v1/organizations/${encodeURIComponent(orgId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({ principalId, role }),
    },
    toOrgMember,
  );
}

async function removeOrgMemberDefault(
  orgId: string,
  principalId: string,
): Promise<void> {
  await call(
    `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(principalId)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

function createOrganizationDefault(
  input: CreateOrganizationInput,
): Promise<CreatedOrganization> {
  return call(
    "/v1/organizations",
    {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        displayName: input.displayName,
        ...(input.ssoIssuer ? { ssoIssuer: input.ssoIssuer } : undefined),
      }),
    },
    toCreatedOrganization,
  );
}

/**
 * The approve-a-device ceremony's known failure set, in plain words. The
 * control plane proxies to the Host with its operator token, so failures come
 * from either plane — the error code says which
 * (apps/control-plane/src/routes/device.ts).
 */
function approveDeviceWords(error: DirectoryError): string {
  if (error.code === "operator_token_unconfigured") {
    return "Device approval is not enabled on this Identity service — the operator sets OPENSESAME_OPERATOR_TOKEN.";
  }
  if (error.code === "host_api_unreachable") {
    return "The Host is unreachable, so the approval could not be delivered. Start the Host and try again.";
  }
  if (error.code === "host_approval_failed" && error.status === 404) {
    return "No device is waiting on that code — check the code the device shows and try again.";
  }
  if (error.code === "host_approval_failed") {
    return "The Host could not approve that code — ask the device for a fresh one and try again.";
  }
  if (error.code === "invalid_request") {
    return "Enter the user code exactly as the device shows it.";
  }
  if (error.code === "organization_id_required") {
    return "You belong to several organizations — the operator approves devices for those.";
  }
  if (error.code === "organization_access_denied") {
    return "You do not have access to the organization that device is joining.";
  }
  return error.message;
}

/**
 * `POST /v1/device/approve` — browsers never hold the operator token; the
 * control plane injects it and forwards `{user_code, principal, …}` to the
 * Host. Only the user code leaves this client.
 */
async function approveDeviceDefault(userCode: string): Promise<DeviceApproval> {
  try {
    return await call(
      "/v1/device/approve",
      { method: "POST", body: JSON.stringify({ user_code: userCode }) },
      (body) => {
        const raw = obj(body);
        return {
          ok: raw.ok === true,
          status: isNumber(raw.status) ? raw.status : 200,
        };
      },
    );
  } catch (error) {
    if (error instanceof DirectoryError) {
      throw new DirectoryError(
        error.status,
        error.code,
        approveDeviceWords(error),
      );
    }
    throw error;
  }
}

export const directorySeams = {
  getMe: getMeDefault,
  listLinkedIdentities: listLinkedIdentitiesDefault,
  unlinkIdentity: unlinkIdentityDefault,
  listOAuthClients: listOAuthClientsDefault,
  createOAuthClient: createOAuthClientDefault,
  rotateOAuthClient: rotateOAuthClientDefault,
  revokeOAuthClient: revokeOAuthClientDefault,
  listOrgMembers: listOrgMembersDefault,
  addOrgMember: addOrgMemberDefault,
  removeOrgMember: removeOrgMemberDefault,
  createOrganization: createOrganizationDefault,
  approveDevice: approveDeviceDefault,
};

export function getMe(): Promise<DirectoryPrincipal> {
  return directorySeams.getMe();
}
export function listLinkedIdentities(): Promise<LinkedIdentity[]> {
  return directorySeams.listLinkedIdentities();
}
export function unlinkIdentity(id: string): Promise<void> {
  return directorySeams.unlinkIdentity(id);
}
export function listOAuthClients(): Promise<OAuthClient[]> {
  return directorySeams.listOAuthClients();
}
export function createOAuthClient(
  ...args: Parameters<typeof createOAuthClientDefault>
): ReturnType<typeof createOAuthClientDefault> {
  return directorySeams.createOAuthClient(...args);
}
export function rotateOAuthClient(id: string): Promise<OAuthClient> {
  return directorySeams.rotateOAuthClient(id);
}
export function revokeOAuthClient(id: string): Promise<OAuthClient> {
  return directorySeams.revokeOAuthClient(id);
}
export function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  return directorySeams.listOrgMembers(orgId);
}
export function addOrgMember(
  ...args: Parameters<typeof addOrgMemberDefault>
): ReturnType<typeof addOrgMemberDefault> {
  return directorySeams.addOrgMember(...args);
}
export function removeOrgMember(
  ...args: Parameters<typeof removeOrgMemberDefault>
): ReturnType<typeof removeOrgMemberDefault> {
  return directorySeams.removeOrgMember(...args);
}
export function createOrganization(
  ...args: Parameters<typeof createOrganizationDefault>
): ReturnType<typeof createOrganizationDefault> {
  return directorySeams.createOrganization(...args);
}
export function approveDevice(userCode: string): Promise<DeviceApproval> {
  return directorySeams.approveDevice(userCode);
}
