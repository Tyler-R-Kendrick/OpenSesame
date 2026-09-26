/**
 * Configured connectors on Vercel Connect (ADR 0146): create one with its
 * whole OAuth / MCP / API-key configuration, read it back, edit it, authorize
 * it on behalf of a person, and prove a person's token can be acquired.
 *
 * The relay is preferred (it holds the Vercel token); a sealed session token
 * is the fallback for create/read/update/authorize. Proving a token is
 * relay-only: the relay asks Connect for the token, calls the service's
 * read-only verify endpoint with it, and answers with metadata — the page
 * never sees a provider token (ADR 0005).
 */
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { connectCallbackBase } from "./connect-callback.js";
import {
  type ConnectSubject,
  type ConnectorDraft,
  authorizeBody,
  createBody,
  draftProblems,
  updateBody,
  updateProblems,
} from "./connect-create.js";
import type { ConnectPlan } from "./connect-plan.js";
import type { Connection } from "./connections.js";
import { connectorOf, iso, toConnectConnection } from "./vercel-connect-map.js";
import {
  type VercelAuthorizeResult,
  connectFetch,
  connectReturnTo,
  relayMutation,
  teamQuery,
} from "./vercel-connect-ops.js";
import { connectRelayConfigured, relayFetch } from "./vercel-connect-relay.js";
import {
  ConnectError,
  rememberConnector,
  requireAuth,
  requireTransport,
} from "./vercel-connect.js";

export type ConnectorDetail = {
  id: string;
  uid: string;
  name: string;
  service: string;
  type: string;
  clientId: string;
  serverUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  userinfoEndpoint: string;
  tokenAuth: string;
  /** `null` when Connect's answer does not say. */
  pkce: "S256" | "none" | "required" | null;
  authorizationParams: Record<string, string>;
  scopes: string[];
  /** `null` when Connect's answer does not say. */
  refreshTokens: boolean | null;
  /** Where the provider must send the browser back; register it there. */
  redirectUri: string;
  serviceUrls: string[];
  subjectType: string;
  instructions: string;
};

function text(value: BoundaryValue | undefined, max = 512): string {
  return isString(value) ? value.trim().slice(0, max) : "";
}

function strings(value: BoundaryValue | undefined, max = 64): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (isString(item) && out.length < max) out.push(item.slice(0, 256));
  }
  return out;
}

function object(value: BoundaryValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function stringRecord(value: BoundaryValue | undefined) {
  return Object.fromEntries(
    Object.entries(object(value)).flatMap(([key, item]) =>
      isString(item) ? [[key, item.slice(0, 256)] as const] : [],
    ),
  );
}

function pkceOf(data: JsonObject): ConnectorDetail["pkce"] {
  if (data.pkceRequired === true) return "required";
  if (text(data.codeChallengeMethod)) return "S256";
  // Only an explicit answer says there is no PKCE; silence says nothing.
  return data.pkceRequired === false || data.codeChallengeMethod === null
    ? "none"
    : null;
}

/** Connect's connector JSON → the fields a settings page shows. */
export function connectorDetailFrom(
  value: BoundaryValue,
): ConnectorDetail | null {
  const row = connectorOf(value);
  if (!row) return null;
  const id = text(row.id, 128) || text(row.uid, 128);
  if (!id) return null;
  const data = object(row.data);
  const server = object(data.serverConfig);
  const user = object(data.userAuthorization);
  const pkce = pkceOf(data);
  return {
    id,
    uid: text(row.uid, 128),
    name: text(row.name, 128),
    service: text(row.service, 128),
    type: text(row.type, 64),
    clientId: text(data.clientId),
    serverUrl: text(data.serverUrl),
    authorizationEndpoint: text(server.authorization_endpoint),
    tokenEndpoint: text(server.token_endpoint),
    revocationEndpoint: text(server.revocation_endpoint),
    userinfoEndpoint: text(server.userinfo_endpoint),
    tokenAuth: text(data.tokenEndpointAuthMethod, 64),
    pkce,
    authorizationParams: stringRecord(data.authorizationUrlParams),
    scopes: strings(user.scopes),
    refreshTokens:
      isJsonObject(data.refreshTokens) && isBoolean(data.refreshTokens.enabled)
        ? data.refreshTokens.enabled
        : null,
    redirectUri:
      text(row.redirectUri) ||
      text(row.redirectUrl) ||
      text(row.callbackUrl) ||
      text(data.redirectUri),
    serviceUrls: strings(data.serviceUrls, 8),
    subjectType: text(data.subjectType, 16),
    instructions: text(data.instructions, 4000),
  };
}

function refuseInvalid(draft: ConnectorDraft): void {
  const problems = draftProblems(draft);
  if (problems.length > 0) {
    throw new ConnectError(0, "invalid_draft", problems.join(" "));
  }
}

/** Create a connector carrying its whole configuration. */
export async function createConfiguredConnector(
  plan: ConnectPlan,
  draft: ConnectorDraft,
): Promise<Connection> {
  if (plan.refused) {
    throw new ConnectError(0, "refused", "This connector is not connectable.");
  }
  refuseInvalid(draft);
  const body = createBody(plan, draft);
  const transport = requireTransport();
  const reply =
    transport === "relay"
      ? await relayFetch(
          "/api/connect/connectors",
          relayMutation({ connector: body }),
        )
      : await connectFetch(`/v1/connect/connectors${teamQuery(transport)}`, {
          method: "POST",
          body: JSON.stringify(
            transport.projectId
              ? { ...body, projectId: transport.projectId }
              : body,
          ),
        });
  const mapped = toConnectConnection(
    connectorOf(reply) ?? {},
    transport === "relay" ? {} : transport,
  );
  if (!mapped) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return a connector.",
    );
  }
  rememberConnector(mapped.connectionId);
  return mapped;
}

/** One connector's settings, read back from Connect. */
export async function readConnector(id: string): Promise<ConnectorDetail> {
  const reply = connectRelayConfigured()
    ? await relayFetch(
        "/api/connect/connector/read",
        relayMutation({ connectorId: id }),
      )
    : await connectFetch(
        `/v1/connect/connectors/${encodeURIComponent(id)}${teamQuery(requireAuth())}`,
      );
  const detail = connectorDetailFrom(reply);
  if (!detail) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return a connector.",
    );
  }
  return detail;
}

/**
 * Save what a person changed against `held`, the settings as read back. A
 * blank client secret keeps the stored one; an edit that introduces a problem
 * is refused before anything is sent.
 */
export async function updateConnector(
  id: string,
  draft: ConnectorDraft,
  held: ConnectorDraft,
): Promise<ConnectorDetail> {
  const problems = updateProblems(draft, held);
  if (problems.length > 0) {
    throw new ConnectError(0, "invalid_draft", problems.join(" "));
  }
  const body = updateBody(draft, held);
  const reply = connectRelayConfigured()
    ? await relayFetch(
        "/api/connect/connector/update",
        relayMutation({ connectorId: id, update: body }),
      )
    : await connectFetch(
        `/v1/connect/connectors/${encodeURIComponent(id)}${teamQuery(requireAuth())}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
  const detail = connectorDetailFrom(reply);
  if (!detail) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return a connector.",
    );
  }
  return detail;
}

function relayCallback(id: string): string | undefined {
  const relay = connectCallbackBase().replace(/\/+$/, "");
  return relay
    ? `${relay}/api/connect/callback?return_to=${encodeURIComponent(connectReturnTo(id))}`
    : undefined;
}

/** Start an authorization for a person (default) or the app itself. */
export async function authorizeConnectorAs(
  id: string,
  subject: ConnectSubject,
  scopes: readonly string[],
): Promise<VercelAuthorizeResult> {
  const callbackUrl = relayCallback(id);
  const relayed: JsonObject = { connectorId: id, subject, scopes: [...scopes] };
  if (callbackUrl) relayed.callbackUrl = callbackUrl;
  const reply = connectRelayConfigured()
    ? await relayFetch("/api/connect/authorize", relayMutation(relayed))
    : await connectFetch(
        `/v1/connect/authorize/${encodeURIComponent(id)}${teamQuery(requireAuth())}`,
        {
          method: "POST",
          body: JSON.stringify(authorizeBody(subject, scopes, callbackUrl)),
        },
      );
  const answer = object(reply);
  const url = text(answer.url, 4096);
  if (!url) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return an authorization URL.",
    );
  }
  return {
    authorizationUrl: url,
    expiresAt: answer.expiresAt
      ? iso(answer.expiresAt)
      : new Date(Date.now() + 600_000).toISOString(),
  };
}

export type TokenCheck = {
  subject: "user" | "app";
  /** ISO time the token Connect issued stops working; "" when unstated. */
  expiresAt: string;
  scopes: string[];
  /** First 12 hex of SHA-256(token): proves a token exists, reveals nothing. */
  fingerprint: string;
  /** The service's own answer to its read-only verify call, when it has one. */
  verified: { status: number; ok: boolean; account: string } | null;
};

export function tokenCheckFrom(value: BoundaryValue): TokenCheck | null {
  const body = object(value);
  const fingerprint = text(body.fingerprint, 12);
  if (!/^[0-9a-f]{12}$/.test(fingerprint)) return null;
  const verified = object(body.verified);
  return {
    subject: body.subject === "app" ? "app" : "user",
    expiresAt: body.expiresAt ? iso(body.expiresAt) : "",
    scopes: strings(body.scopes),
    fingerprint,
    verified: isNumber(verified.status)
      ? {
          status: verified.status,
          ok: verified.ok === true,
          account: text(verified.account, 80),
        }
      : null,
  };
}

/**
 * Prove a person's token can be acquired: the relay requests it from Connect
 * and answers with metadata only. Needs the relay; a sealed Vercel token in
 * the page would mean holding the provider token here.
 */
export async function checkConnectorToken(
  id: string,
  subject: ConnectSubject,
  scopes: readonly string[] = [],
): Promise<TokenCheck> {
  if (!connectRelayConfigured()) {
    throw new ConnectError(
      0,
      "relay_required",
      "Proving a token needs this deployment's Connect relay.",
    );
  }
  const reply = await relayFetch(
    "/api/connect/token-check",
    relayMutation({ connectorId: id, subject, scopes: [...scopes] }),
  );
  const check = tokenCheckFrom(reply);
  if (!check) {
    throw new ConnectError(0, "malformed", "The relay did not prove a token.");
  }
  return check;
}
