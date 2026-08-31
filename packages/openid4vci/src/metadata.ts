/**
 * Credential Issuer Metadata — the document at
 * `/.well-known/openid-credential-issuer`.
 *
 * This is the only thing a wallet reads before it starts trusting us, so every
 * value in it is a commitment. Three of those commitments carry security
 * weight and are worth stating before the code:
 *
 * - **`proof_signing_alg_values_supported` is an allow-list, not a hint.**
 *   OpenID4VCI 1.0 §Appendix F.1 says the `alg` of a key proof MUST match one
 *   of the advertised values. That makes this array the published half of the
 *   check in `proof.ts`, and the two are built from the same constant so they
 *   cannot drift: an issuer that advertises `ES256` and accepts `RS256`
 *   anyway is advertising a policy it does not have.
 * - **`nonce_endpoint` being present is what makes `nonce` mandatory.**
 *   §Appendix F.1 makes the proof's `nonce` claim REQUIRED exactly when the
 *   issuer has a Nonce Endpoint. We always publish one, so replay protection
 *   is never optional for a wallet talking to us — there is no configuration
 *   in which it can be turned off, which is why the field is not configurable.
 * - **Every URL must be `https` and share the issuer's origin.** The origin
 *   check is not in the specification. It is here because a c_nonce is only
 *   worth anything if it was minted by the party that will check it, and a
 *   configuration typo that points `nonce_endpoint` at a neighbouring host
 *   silently converts our replay defence into "whatever that host says".
 *
 * Nothing in this file has a default URL. A caller that forgets a field gets
 * an `Openid4vciError`, never a placeholder that resolves somewhere real.
 */

import {
  type JsonObject,
  type MutableJsonObject,
  isString,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";

/**
 * The well-known suffix, and the path segment it is inserted as.
 *
 * OpenID4VCI 1.0 §12.2.2: the string is inserted into the Credential Issuer
 * Identifier *between the host component and the path component* — so
 * `https://issuer.example/tenant` publishes at
 * `https://issuer.example/.well-known/openid-credential-issuer/tenant`, not at
 * `.../tenant/.well-known/...`. The difference matters for multi-tenant
 * deployments and is the kind of thing that is quietly wrong for months.
 */
export const CREDENTIAL_ISSUER_WELL_KNOWN =
  "/.well-known/openid-credential-issuer";

/**
 * The Credential Format Identifier this package issues.
 *
 * OpenID4VCI 1.0 §A.3.1, and required by OpenID4VC HAIP 1.0 for SD-JWT VC.
 * The older `vc+sd-jwt` spelling is deliberately absent from what we *emit*:
 * a transitional issuer that emits both formats doubles the number of things
 * a verifier must accept, and the transition is meant to end.
 */
export const CREDENTIAL_FORMAT = "dc+sd-jwt";

/**
 * Signature algorithms this package will sign with or accept in a key proof.
 *
 * `ES256` is the interoperability floor — HAIP 1.0 requires P-256 with
 * ES256 of every issuer, holder and verifier. `EdDSA` is here because Ed25519
 * is what OpenSesame device keys are elsewhere in this repository, and
 * requiring a second curve just to be issued a credential would push
 * deployments toward a key they do not otherwise hold.
 *
 * Nothing else. No RSA: it widens the parameter surface (key sizes, PSS salt
 * lengths, padding checks) for no gain in this ecosystem. No `HS*`: a
 * symmetric algorithm in an issuer means the verifying party can also mint,
 * which is not a credential. No `none`: see `proof.ts`.
 */
export const SUPPORTED_ALGORITHMS = ["ES256", "EdDSA"] as const;

export type SupportedAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

export function isSupportedAlgorithm(
  value: string,
): value is SupportedAlgorithm {
  return SUPPORTED_ALGORITHMS.some((candidate) => candidate === value);
}

/** Display metadata for one locale. Optional everywhere it appears. */
export interface CredentialDisplay {
  readonly name: string;
  readonly locale?: string;
  readonly description?: string;
}

/**
 * Everything an issuer must state about itself. No field has a default.
 *
 * `credentialConfigurationId` and `vct` are separate because they answer
 * different questions: the configuration id is the key a wallet names in a
 * Credential Offer and a Credential Request, while the `vct` is what ends up
 * inside the signed credential and is what a *verifier* matches on. Deployments
 * that conflate them discover the difference when they need to rotate one.
 */
export interface IssuerMetadataConfig {
  /** The Credential Issuer Identifier. `https`, no query, no fragment. */
  readonly credentialIssuer: string;
  /** Absolute URL of the Credential Endpoint. Same origin as the issuer. */
  readonly credentialEndpoint: string;
  /** Absolute URL of the Nonce Endpoint. Same origin as the issuer. */
  readonly nonceEndpoint: string;
  /** The key under `credential_configurations_supported`. */
  readonly credentialConfigurationId: string;
  /** The `vct` written into every credential of this configuration. */
  readonly vct: string;
  /** The algorithm the issuer signs credentials with. */
  readonly credentialSigningAlgorithm: SupportedAlgorithm;
  /** Non-empty. Algorithms a wallet may sign its key proof with. */
  readonly proofSigningAlgorithms: readonly SupportedAlgorithm[];
  /**
   * Authorization Server identifiers, when authorization is delegated.
   *
   * Omitted means the Credential Issuer is also the Authorization Server,
   * which is what the pre-authorized-code-only deployment in this package is.
   */
  readonly authorizationServers?: readonly string[];
  readonly display?: readonly CredentialDisplay[];
}

/**
 * The metadata document, typed loosely on purpose.
 *
 * A wallet parses this as JSON and the specification permits parameters we do
 * not emit, so pinning a closed interface here would only invite a cast at the
 * one call site that needs to add a field. What is *guaranteed* is checked by
 * {@link buildIssuerMetadata}'s tests, not by this type.
 */
export type IssuerMetadata = JsonObject;

/** Parsed, validated absolute URL — or a refusal. */
function requireHttpsUrl(value: string | undefined): URL {
  if (!isString(value) || value.length === 0) {
    refuse("invalid_issuer_configuration");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse("invalid_issuer_configuration");
  }
  // `https` only, including in development. A metadata document fetched over
  // cleartext can be rewritten in flight, and every subsequent check in this
  // package — audience, nonce origin, signing key — trusts values that came
  // from it. There is no dev carve-out because a carve-out is what ships.
  if (url.protocol !== "https:") refuse("invalid_issuer_configuration");
  return url;
}

function requireNonEmpty(value: string | undefined): string {
  if (!isString(value) || value.trim().length === 0) {
    refuse("invalid_issuer_configuration");
  }
  return value;
}

/** A validated Credential Issuer Identifier and its parsed form. */
export interface CredentialIssuerIdentifier {
  /** The exact string to emit and to compare against. */
  readonly identifier: string;
  readonly url: URL;
}

/**
 * The Credential Issuer Identifier, validated and pinned to one spelling.
 *
 * §12.2.4 requires the `credential_issuer` value in the published document to
 * be byte-identical to the identifier the wallet inserted the well-known
 * string into, "compared using a simple string comparison with no
 * normalization". Two spellings of one issuer therefore is not a cosmetic
 * problem — it is a document half our wallets must reject.
 *
 * So exactly one spelling is accepted: origin, optionally followed by a path
 * with no trailing slash, and nothing else. Note that this is deliberately
 * *not* `new URL(x).href`, which appends a slash to a bare origin: an issuer
 * that stored `https://issuer.example` would then publish
 * `https://issuer.example/` and fail the wallet's comparison against the
 * string it actually used. The canonical form is the one wallets type.
 */
export function parseCredentialIssuer(
  credentialIssuer: string,
): CredentialIssuerIdentifier {
  const url = requireHttpsUrl(credentialIssuer);
  if (url.search.length > 0 || url.hash.length > 0) {
    refuse("invalid_issuer_configuration");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    refuse("invalid_issuer_configuration");
  }
  const path = url.pathname === "/" ? "" : url.pathname;
  if (path.endsWith("/")) refuse("invalid_issuer_configuration");
  const identifier = `${url.origin}${path}`;
  if (identifier !== credentialIssuer) refuse("invalid_issuer_configuration");
  return { identifier, url };
}

/**
 * Where a wallet fetches this issuer's metadata.
 *
 * Implements the "insert between host and path" rule of §12.2.2 literally,
 * because the obvious `new URL(WELL_KNOWN, issuer)` does not: for a
 * path-bearing identifier it would drop the tenant segment and point every
 * tenant at the same document.
 */
export function issuerMetadataUrl(credentialIssuer: string): string {
  const { url } = parseCredentialIssuer(credentialIssuer);
  const tenantPath = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}${CREDENTIAL_ISSUER_WELL_KNOWN}${tenantPath}`;
}

/**
 * Reject an endpoint that is not on the issuer's own origin.
 *
 * See the file header: a nonce minted somewhere else is not replay protection,
 * and a credential endpoint on another origin is another issuer.
 */
function requireSameOrigin(endpoint: string, issuer: URL): string {
  const url = requireHttpsUrl(endpoint);
  if (url.origin !== issuer.origin) refuse("invalid_issuer_configuration");
  return url.href;
}

/**
 * One display entry, with absent fields omitted rather than emitted as null.
 *
 * Built statement by statement because a conditional spread hides the omission
 * inside an expression, and the difference between "no locale" and "locale:
 * undefined" is visible on the wire once this is serialized.
 */
function displayObject(entry: CredentialDisplay): JsonObject {
  const object: MutableJsonObject = { name: entry.name };
  if (entry.locale !== undefined) object.locale = entry.locale;
  if (entry.description !== undefined) object.description = entry.description;
  return object;
}

/**
 * Build the `/.well-known/openid-credential-issuer` document.
 *
 * The one `credential_configurations_supported` entry is the whole point of
 * the package: OpenSesame issues exactly one kind of credential, so a
 * configuration map with one key is not a limitation to be generalized later
 * — it is the honest shape of what we do.
 */
export function buildIssuerMetadata(
  config: IssuerMetadataConfig,
): IssuerMetadata {
  const issuer = parseCredentialIssuer(
    requireNonEmpty(config.credentialIssuer),
  );
  const credentialEndpoint = requireSameOrigin(
    config.credentialEndpoint,
    issuer.url,
  );
  const nonceEndpoint = requireSameOrigin(config.nonceEndpoint, issuer.url);
  const configurationId = requireNonEmpty(config.credentialConfigurationId);
  const vct = requireNonEmpty(config.vct);

  if (!isSupportedAlgorithm(config.credentialSigningAlgorithm)) {
    refuse("invalid_issuer_configuration");
  }
  const proofAlgorithms = config.proofSigningAlgorithms ?? [];
  if (proofAlgorithms.length === 0) refuse("invalid_issuer_configuration");
  for (const algorithm of proofAlgorithms) {
    if (!isSupportedAlgorithm(algorithm))
      refuse("invalid_issuer_configuration");
  }

  const authorizationServers = config.authorizationServers;
  if (authorizationServers !== undefined) {
    // §12.2.4 makes this a *non-empty* array when present. An empty array is
    // not "no delegation" — it is a document a conforming wallet must reject,
    // so we refuse to emit one rather than let it reach the wire.
    if (authorizationServers.length === 0)
      refuse("invalid_issuer_configuration");
    for (const server of authorizationServers) requireHttpsUrl(server);
  }

  const display = config.display;
  if (display !== undefined) {
    if (display.length === 0) refuse("invalid_issuer_configuration");
    for (const entry of display) requireNonEmpty(entry.name);
  }

  // No `scope`. §12.2.4 makes it optional, and it is only reachable through
  // the Authorization Code flow, which this package does not implement. Its
  // absence is also the first place a reader can see the design rule: this
  // credential is not associated with an OAuth scope anywhere, because a
  // scope is an authorization grant and this credential grants nothing.
  const credentialConfiguration: MutableJsonObject = {
    format: CREDENTIAL_FORMAT,
    vct,
    // `jwk` — the credential is bound to a raw public key carried in `cnf`.
    // Not `did:*`: a DID method is a resolution dependency, and an issuer that
    // must resolve a document over the network to check holder binding has
    // made an availability problem out of a signature check.
    cryptographic_binding_methods_supported: ["jwk"],
    credential_signing_alg_values_supported: [
      config.credentialSigningAlgorithm,
    ],
    proof_types_supported: {
      // Only `jwt`. `attestation` (§Appendix F, key attestation without proof
      // of possession) is absent because it issues a credential to a key that
      // never signed anything, and `di_vp` is absent because it drags in the
      // W3C Data Integrity stack for a second way to say the same thing.
      jwt: {
        proof_signing_alg_values_supported: [...proofAlgorithms],
      },
    },
  };
  if (display !== undefined) {
    credentialConfiguration.credential_metadata = {
      display: display.map(displayObject),
    };
  }

  const document: MutableJsonObject = {
    credential_issuer: issuer.identifier,
    credential_endpoint: credentialEndpoint,
    nonce_endpoint: nonceEndpoint,
  };
  if (authorizationServers !== undefined) {
    document.authorization_servers = [...authorizationServers];
  }
  document.credential_configurations_supported = {
    [configurationId]: credentialConfiguration,
  };
  return document;
}
