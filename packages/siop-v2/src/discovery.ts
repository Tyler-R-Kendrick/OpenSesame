/**
 * What a Pages deployment publishes to relying parties, and the consumer that
 * reads it (ADR 0161).
 *
 * The document is **SIOP-shaped metadata, not an OpenID Connect Discovery
 * document**. It is a static file at a path a GitHub project page can serve
 * (`<origin><base>siop-metadata.json`), it carries no `jwks_uri` (a shared
 * static origin has no per-person keys to list: the key is the `sub_jwk` in
 * the token) and no `token_endpoint` (a static origin has nothing to answer a
 * back-channel POST). A generic OIDC client that needs either must not be
 * pointed at it, and `opensesame.conventional_oidc: false` says so in the
 * document itself.
 *
 * The capability fields come from {@link STATIC_SIOP_METADATA} (ADR 0139): the
 * draft static document and the published one cannot drift apart because the
 * second is built from the first.
 */

import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";
import { constantTimeEquals } from "./encoding.js";
import { refuse } from "./errors.js";
import { STATIC_SIOP_METADATA, assertAllowedIssuer } from "./issuer.js";

/** The file a deployment publishes, relative to its base path. */
export const SIOP_METADATA_FILE = "siop-metadata.json" as const;

/** The issuer's path under the base: the consent route is the issuer. */
export const PAGES_SIOP_ISSUER_PATH = "identity/siop" as const;

/** The pinned draft the document names. */
export const SIOP_DRAFT = "openid-connect-self-issued-v2-1_0-07" as const;

export const MAX_SIOP_METADATA_BYTES = 8_192;
export const DEFAULT_METADATA_TIMEOUT_MS = 5_000;

const {
  issuer: _draftIssuer,
  authorization_endpoint: _draftEndpoint,
  ...CAPABILITIES
} = STATIC_SIOP_METADATA;

export type PagesSiopMetadata = Omit<
  typeof STATIC_SIOP_METADATA,
  "issuer" | "authorization_endpoint"
> & {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly response_modes_supported: readonly ["fragment"];
  readonly opensesame: typeof PAGES_SIOP_EXTENSION;
};

/**
 * Facts about this OP that standard metadata has no field for. Every value is
 * a statement a reader can check against ADR 0161, none is a promise of a
 * conformance result.
 */
export const PAGES_SIOP_EXTENSION = {
  profile: "self-issued-op-dynamic-issuer",
  specification: SIOP_DRAFT,
  conventional_oidc: false,
  client_registration: "person-registers-the-application-in-their-own-vault",
  key_discovery: "sub_jwk-in-the-id_token",
  id_token_claims: [
    "iss",
    "sub",
    "aud",
    "nonce",
    "exp",
    "iat",
    "sub_jwk",
    "i_am_siop",
  ],
} as const;

export type PagesOrigin = {
  /** `https://host` or loopback `http://host:port`: an origin, nothing after it. */
  readonly origin: string;
  /** The deployment's base path, `/OpenSesame/` or `/`. */
  readonly basePath: string;
};

/**
 * The origin and base path of a deployment written as one URL
 * (`https://host/OpenSesame`, with or without the trailing slash): the form a
 * relying party's configuration takes.
 */
export function pagesOriginOf(pagesUrl: string): PagesOrigin {
  let url: URL;
  try {
    url = new URL(pagesUrl);
  } catch {
    refuse("malformed_metadata", "metadata");
  }
  if (url.search !== "" || url.hash !== "") {
    refuse("malformed_metadata", "metadata");
  }
  if (url.username !== "" || url.password !== "") {
    refuse("malformed_metadata", "metadata");
  }
  return { origin: url.origin, basePath: url.pathname };
}

function baseUrl(where: PagesOrigin): URL {
  let origin: URL;
  try {
    origin = new URL(where.origin);
  } catch {
    refuse("malformed_metadata", "metadata");
  }
  if (origin.origin !== where.origin) refuse("malformed_metadata", "metadata");
  const path = where.basePath.startsWith("/")
    ? where.basePath
    : `/${where.basePath}`;
  const base = new URL(path.endsWith("/") ? path : `${path}/`, origin);
  if (base.search !== "" || base.hash !== "") {
    refuse("malformed_metadata", "metadata");
  }
  return base;
}

/**
 * The issuer a Pages deployment signs as: its origin and base path plus the
 * consent route. Origin plus base path *is* the issuer, so a fork, a custom
 * domain or a changed base path is a different issuer (ADR 0161 §6).
 */
export function pagesSiopIssuer(where: PagesOrigin): string {
  const issuer = new URL(PAGES_SIOP_ISSUER_PATH, baseUrl(where)).href;
  assertAllowedIssuer(issuer);
  return issuer;
}

/** The published document's URL for an issuer `pagesSiopIssuer` produced. */
export function siopMetadataUrl(issuer: string): string {
  assertAllowedIssuer(issuer);
  const url = new URL(issuer);
  const tail = `/${PAGES_SIOP_ISSUER_PATH}`;
  if (!url.pathname.endsWith(tail)) refuse("malformed_metadata", "metadata");
  url.pathname = `${url.pathname.slice(0, -PAGES_SIOP_ISSUER_PATH.length)}${SIOP_METADATA_FILE}`;
  return url.href;
}

/** The document a deployment at `where` publishes. */
export function buildPagesSiopMetadata(where: PagesOrigin): PagesSiopMetadata {
  const issuer = pagesSiopIssuer(where);
  return {
    issuer,
    authorization_endpoint: issuer,
    ...CAPABILITIES,
    response_modes_supported: ["fragment"],
    opensesame: PAGES_SIOP_EXTENSION,
  };
}

/** The bytes a deployment publishes: stable key order, one trailing newline. */
export function serializePagesSiopMetadata(where: PagesOrigin): string {
  return `${JSON.stringify(buildPagesSiopMetadata(where), null, 2)}\n`;
}

/** What a relying party takes from a document it has accepted. */
export type AcceptedSiopMetadata = {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
};

function listIncludes(
  doc: { readonly [key: string]: JsonValue | undefined },
  field: string,
  wanted: string,
): boolean {
  const value = doc[field];
  return Array.isArray(value) && value.some((entry) => entry === wanted);
}

function sameOriginEndpoint(endpoint: string, issuer: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    refuse("malformed_metadata", "metadata");
  }
  if (url.origin !== new URL(issuer).origin) {
    refuse("malformed_metadata", "metadata");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    refuse("malformed_metadata", "metadata");
  }
  return url.href;
}

/**
 * Accept a document only if it names the issuer the relying party already
 * expects and promises what this kit can consume: `id_token`, `openid`,
 * ES256, JWK-thumbprint subjects, and an authorization endpoint on the
 * issuer's own origin. Anything else is refused, never partially used.
 */
export function parseSiopMetadata(
  raw: JsonValue,
  expectedIssuer: string,
): AcceptedSiopMetadata {
  assertAllowedIssuer(expectedIssuer);
  if (!isJsonObject(raw)) refuse("malformed_metadata", "metadata");
  const issuer = raw.issuer;
  if (!isString(issuer) || !constantTimeEquals(issuer, expectedIssuer)) {
    refuse("issuer_mismatch", "metadata");
  }
  const endpoint = raw.authorization_endpoint;
  if (!isString(endpoint)) refuse("malformed_metadata", "metadata");
  const authorizationEndpoint = sameOriginEndpoint(endpoint, expectedIssuer);
  assertAllowedIssuer(authorizationEndpoint);
  const required: ReadonlyArray<readonly [string, string]> = [
    ["response_types_supported", "id_token"],
    ["scopes_supported", "openid"],
    ["id_token_signing_alg_values_supported", "ES256"],
    ["subject_syntax_types_supported", "urn:ietf:params:oauth:jwk-thumbprint"],
  ];
  for (const [field, wanted] of required) {
    if (!listIncludes(raw, field, wanted)) {
      refuse("malformed_metadata", "metadata");
    }
  }
  if (
    raw.response_modes_supported !== undefined &&
    !listIncludes(raw, "response_modes_supported", "fragment")
  ) {
    refuse("malformed_metadata", "metadata");
  }
  return { issuer: expectedIssuer, authorizationEndpoint };
}

/** The slice of a fetch `Response` the consumer reads. */
export type MetadataResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type MetadataFetch = (
  url: string,
  init: {
    readonly redirect: "error";
    readonly headers: { readonly accept: string };
    readonly signal: AbortSignal;
  },
) => Promise<MetadataResponse>;

export type FetchSiopMetadataInput = {
  readonly fetch: MetadataFetch;
  readonly expectedIssuer: string;
  /** Defaults to the URL `siopMetadataUrl(expectedIssuer)` derives. */
  readonly metadataUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
};

function readJsonText(text: string): JsonValue {
  if (text.length > MAX_SIOP_METADATA_BYTES) refuse("limit_exceeded", "limits");
  try {
    // JSON.parse yields JSON; `parseSiopMetadata` shape-checks every field it reads.
    const value: JsonValue = JSON.parse(text);
    return value;
  } catch {
    refuse("malformed_metadata", "metadata");
  }
}

/**
 * Fetch and accept a deployment's metadata document. The fetch is injected so
 * a server, a browser and a test each bring their own, and the request refuses
 * redirects: a document that moved is a document the issuer did not publish
 * there. Non-JSON answers (a single-page app's `index.html` fallback is the
 * common one) are `malformed_metadata`, not a crash.
 */
export async function fetchSiopMetadata(
  input: FetchSiopMetadataInput,
): Promise<AcceptedSiopMetadata> {
  assertAllowedIssuer(input.expectedIssuer);
  const url = input.metadataUrl ?? siopMetadataUrl(input.expectedIssuer);
  assertAllowedIssuer(new URL(url).origin);
  let response: MetadataResponse;
  try {
    response = await input.fetch(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(
        input.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      ),
    });
  } catch {
    refuse("malformed_metadata", "metadata");
  }
  if (!response.ok) refuse("malformed_metadata", "metadata");
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("json")) {
    refuse("malformed_metadata", "metadata");
  }
  const text = await response.text();
  return parseSiopMetadata(readJsonText(text), input.expectedIssuer);
}
