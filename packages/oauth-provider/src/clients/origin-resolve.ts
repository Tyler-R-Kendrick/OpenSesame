import { randomUUID } from "node:crypto";
import {
  canonicalizeOrigin,
  defaultCallbackUri,
  originClientId,
} from "../origin/canonical.js";
import type { OAuthClientRecord } from "../types.js";
import type { ClientAdmissionPolicy } from "./admission.js";
import type { ClientRecordStore } from "./store.js";

export type ResolveOriginClientOptions = {
  store: ClientRecordStore;
  admission: ClientAdmissionPolicy;
  /** Raw Origin / location.origin string */
  origin: string;
  allowLoopbackHttp?: boolean;
  production?: boolean;
  clock?: () => Date;
  /**
   * Deployment/system principal recorded as the owner of newly auto-admitted
   * origin clients (ADR 0050 R-A): every client has an owner from birth, and
   * the F5 claim flow transfers ownership to the claiming principal. The
   * option is a plain string so this package stays free of principal concepts.
   */
  systemOwnerPrincipalId?: string;
};

function canonicalOptions(options: ResolveOriginClientOptions) {
  const canonicalOpts: Parameters<typeof canonicalizeOrigin>[1] = {
    allowLoopbackHttp: options.allowLoopbackHttp ?? true,
  };
  if (options.production !== undefined) {
    canonicalOpts.production = options.production;
  }
  return canonicalOpts;
}

/**
 * Atomically admit or load an origin_profile public client for a static site
 * (ADR 0050 F2/F4). Authorization path only — the token path must use
 * {@link findOriginClient} so unauthenticated probes cannot insert rows.
 */
export async function resolveOriginClient(
  options: ResolveOriginClientOptions,
): Promise<OAuthClientRecord> {
  if (!options.admission.isModeEnabled("origin_profile")) {
    throw new Error("origin_profile admission is disabled");
  }

  const canonical = canonicalizeOrigin(
    options.origin,
    canonicalOptions(options),
  );
  const id = originClientId(canonical);
  const existing =
    (await options.store.findById(id)) ??
    (await options.store.findByOrigin(canonical));
  if (existing) {
    options.admission.assertAdmissible(existing);
    const nowTouch = (options.clock ?? (() => new Date()))();
    await options.store.touchLastUsed?.(existing.id, nowTouch);
    return existing;
  }

  const now = (options.clock ?? (() => new Date()))();
  const client: OAuthClientRecord = {
    id,
    admissionMode: "origin_profile",
    displayName: `Static site ${canonical}`,
    redirectUris: [defaultCallbackUri(canonical)],
    sectorIdentifier: `sector_${randomUUID()}`,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
    origin: canonical,
    ownershipStatus: "unclaimed",
    ...(options.systemOwnerPrincipalId
      ? { ownerPrincipalId: options.systemOwnerPrincipalId }
      : undefined),
    firstSeenAt: now,
    lastUsedAt: now,
  };
  options.admission.assertAdmissible(client);
  return options.store.insertAtomic(client);
}

/**
 * Look up an already-admitted origin client without inserting.
 * Used for token CORS so unauthenticated /token traffic cannot amplify DB rows.
 */
export async function findOriginClient(
  options: ResolveOriginClientOptions,
): Promise<OAuthClientRecord | undefined> {
  if (!options.admission.isModeEnabled("origin_profile")) {
    return undefined;
  }
  const canonical = canonicalizeOrigin(
    options.origin,
    canonicalOptions(options),
  );
  const id = originClientId(canonical);
  const existing =
    (await options.store.findById(id)) ??
    (await options.store.findByOrigin(canonical));
  if (!existing) return undefined;
  options.admission.assertAdmissible(existing);
  return existing;
}

/** Map OpenSesame client record → oidc-provider ClientMetadata shape. */
export function toOidcClientMetadata(client: OAuthClientRecord) {
  const scopes =
    client.allowedScopes.length > 0 ? client.allowedScopes : ["openid"];
  return {
    client_id: client.id,
    client_name: client.displayName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: scopes.join(" "),
    subject_type: "pairwise",
    application_type: "web",
  };
}
