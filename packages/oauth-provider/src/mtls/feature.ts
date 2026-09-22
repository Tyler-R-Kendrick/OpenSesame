/**
 * RFC 8705 for the OpenSesame issuer (ID-OAUTH / ID-DISCOVERY).
 *
 * Two distinct capabilities, both off unless the provider is created with a
 * `transport` (the Identity plane's TLS listener is configured):
 *
 * - **client authentication** — `tls_client_auth` for confidential clients
 *   pre-registered with exactly one of `tls_client_auth_san_dns` /
 *   `tls_client_auth_san_uri`; compared exactly, never by CN or wildcard;
 * - **access-token binding** — `tls_client_certificate_bound_access_tokens`
 *   on a client makes every token it obtains carry
 *   `cnf: { "x5t#S256": base64url(sha256(leaf DER)) }`, which oidc-provider
 *   re-checks on its own protected routes and Identity re-checks on Hono.
 *
 * `self_signed_tls_client_auth` stays off, and nothing here lets a request
 * register a trust root or a certificate-bound client: `mtlsClientFence`
 * refuses `tls_client_auth` and certificate binding for any request-driven
 * admission (dynamic registration, client metadata documents), so only the
 * pre-registered/admin path can grant them.
 *
 * Only documented oidc-provider 9.11 option names are used:
 * `features.mTLS.{enabled,certificateBoundAccessTokens,tlsClientAuth,
 * selfSignedTlsClientAuth,getCertificate,certificateAuthorized,
 * certificateSubjectMatches}` and the `discovery` object.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { KoaContext } from "oidc-provider";

/** What the issuer needs to know about a verified socket peer. */
export interface MtlsPeer {
  /** PEM of the verified leaf; oidc-provider derives `x5t#S256` from it. */
  certificatePem(): string;
  /** Validated DNS SANs, lowercase, no wildcards. */
  dnsNames(): readonly string[];
  /** Validated URI SANs (including SPIFFE IDs), exact strings. */
  uris(): readonly string[];
}

export interface MtlsTransport {
  /**
   * The verified peer of a Node socket, or none. The Identity plane answers
   * from its listener registry: a plain socket, an unauthenticated TLS
   * socket, and anything a header claims all resolve to `undefined`.
   */
  peerOf(socket: unknown): MtlsPeer | undefined;
  /**
   * Public base URL of the TLS listener when it is reachable at a different
   * address than the issuer. Present ⇒ discovery advertises
   * `mtls_endpoint_aliases` for the endpoints that listener serves.
   */
  endpointAliasBase?: string;
}

type SocketContext = { req?: { socket?: unknown } };

function peerFromContext(
  transport: MtlsTransport,
  ctx: KoaContext,
): MtlsPeer | undefined {
  const scope: SocketContext | undefined = overlapCast(ctx);
  return transport.peerOf(scope?.req?.socket);
}

const DNS_NAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/** Exact SAN comparison for the two registered properties this issuer honours. */
export function certificateSubjectMatches(
  peer: MtlsPeer | undefined,
  property: string,
  expected: BoundaryValue,
): boolean {
  if (!peer || !isString(expected) || expected.length === 0) return false;
  if (property === "tls_client_auth_san_dns") {
    const name = expected.toLowerCase();
    return DNS_NAME.test(name) && peer.dnsNames().includes(name);
  }
  if (property === "tls_client_auth_san_uri") {
    return peer.uris().includes(expected);
  }
  // subject_dn, san_ip and san_email are not identities here (CONTRACT §3).
  return false;
}

/** `features.mTLS` — enabled only with a transport. */
export function buildMtlsFeature(transport: MtlsTransport | undefined): {
  mTLS: JsonObject | Record<string, BoundaryValue>;
} {
  if (!transport) return { mTLS: { enabled: false } };
  return {
    mTLS: {
      enabled: true,
      certificateBoundAccessTokens: true,
      tlsClientAuth: true,
      selfSignedTlsClientAuth: false,
      getCertificate: (ctx: KoaContext) =>
        peerFromContext(transport, ctx)?.certificatePem(),
      certificateAuthorized: (ctx: KoaContext) =>
        peerFromContext(transport, ctx) !== undefined,
      certificateSubjectMatches: (
        ctx: KoaContext,
        property: string,
        expected: BoundaryValue,
      ) =>
        certificateSubjectMatches(
          peerFromContext(transport, ctx),
          property,
          expected,
        ),
    },
  };
}

const MTLS_ENDPOINT_ALIASES = [
  "token_endpoint",
  "userinfo_endpoint",
  "introspection_endpoint",
  "revocation_endpoint",
  "device_authorization_endpoint",
  "pushed_authorization_request_endpoint",
] as const;

const ALIAS_PATHS: Record<(typeof MTLS_ENDPOINT_ALIASES)[number], string> = {
  token_endpoint: "/token",
  userinfo_endpoint: "/me",
  introspection_endpoint: "/token/introspection",
  revocation_endpoint: "/token/revocation",
  device_authorization_endpoint: "/device/auth",
  pushed_authorization_request_endpoint: "/request",
};

/**
 * Static discovery additions. `mtls_endpoint_aliases` is present only when
 * the TLS listener has its own public base — the aliased endpoints are the
 * same dispatcher served there, so every alias named is actually served.
 */
export function mtlsDiscovery(
  transport: MtlsTransport | undefined,
): JsonObject | undefined {
  const base = transport?.endpointAliasBase?.replace(/\/+$/, "");
  if (!base) return undefined;
  const aliases: JsonObject = {};
  for (const name of MTLS_ENDPOINT_ALIASES) {
    aliases[name] = `${base}${ALIAS_PATHS[name]}`;
  }
  return { mtls_endpoint_aliases: aliases };
}

const DEFAULT_CLIENT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_jwt",
  "client_secret_post",
  "private_key_jwt",
  "none",
] as const;

/**
 * `clientAuthMethods`: oidc-provider's documented default list, plus
 * `tls_client_auth` only when the feature is on — the default list does not
 * grow by itself, and discovery advertises exactly this list.
 */
export function mtlsClientAuthMethods(transport: MtlsTransport | undefined): {
  clientAuthMethods: string[];
} {
  return {
    clientAuthMethods: transport
      ? [...DEFAULT_CLIENT_AUTH_METHODS, "tls_client_auth"]
      : [...DEFAULT_CLIENT_AUTH_METHODS],
  };
}

/** The `discovery` configuration entry, or nothing to spread. */
export function mtlsDiscoveryConfiguration(
  transport: MtlsTransport | undefined,
): { discovery: JsonObject } | Record<string, never> {
  const discovery = mtlsDiscovery(transport);
  return discovery ? { discovery } : {};
}

export type ExtraClientMetadata = {
  properties: string[];
  validator: (
    ctx: KoaContext,
    key: string,
    value: BoundaryValue,
    metadata: BoundaryValue,
  ) => void;
};

const MTLS_FENCE = "os_mtls_fence";
const CERT_AUTH_METHODS = new Set([
  "tls_client_auth",
  "self_signed_tls_client_auth",
]);

/**
 * extraClientMetadata hook: request-driven admissions (dynamic registration,
 * client metadata documents — the only paths that carry a request `ctx`
 * into client construction) may not claim certificate authentication or
 * certificate-bound tokens. Static and store-loaded clients carry no ctx.
 */
export function mtlsClientFence(): ExtraClientMetadata {
  return {
    properties: [MTLS_FENCE],
    validator(ctx, key, _value, metadata) {
      if (key !== MTLS_FENCE || ctx === undefined || ctx === null) return;
      const client: {
        token_endpoint_auth_method?: string;
        tls_client_certificate_bound_access_tokens?: boolean;
        invalidate?: (message: string) => void;
      } = overlapCast(metadata);
      const method = client.token_endpoint_auth_method ?? "";
      if (
        CERT_AUTH_METHODS.has(method) ||
        client.tls_client_certificate_bound_access_tokens === true
      ) {
        client.invalidate?.(
          "certificate authentication and certificate-bound tokens require pre-registration",
        );
      }
    },
  };
}

/** Run several extraClientMetadata hooks as one (oidc-provider takes one). */
export function combineExtraClientMetadata(
  ...parts: ExtraClientMetadata[]
): ExtraClientMetadata {
  return {
    properties: parts.flatMap((p) => p.properties),
    validator(ctx, key, value, metadata) {
      for (const part of parts) {
        if (part.properties.includes(key))
          part.validator(ctx, key, value, metadata);
      }
    },
  };
}
