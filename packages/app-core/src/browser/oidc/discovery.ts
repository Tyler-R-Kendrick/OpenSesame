/** Endpoint selection and bounded metadata checks shared by native BYO and partner OIDC. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { fetchOidcJson } from "@opensesame/sdk-browser";
import { identityEndpoint } from "../../lib/identity-connections-schema.js";
import type { ConfiguredOidc } from "../../lib/identity-oidc-config.js";
import { assertOidcOrganization } from "../../lib/identity-oidc-config.js";

export type Discovery = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  authentication: "none" | "client_secret_basic" | "client_secret_post";
  manual: boolean;
}>;
function endpoint(value: BoundaryValue): string {
  if (!isString(value) || value.length > 2048)
    throw new Error("Invalid configured OIDC endpoint");
  const url = new URL(value);
  if (
    !identityEndpoint(url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid secure configured OIDC endpoint");
  return url.href;
}
export function assertConfiguredOidc(config: ConfiguredOidc): void {
  if (
    !identityEndpoint(config.issuer) ||
    config.issuer.trim() !== config.issuer ||
    !config.clientId ||
    config.clientId.length > 2048 ||
    config.clientId.trim() !== config.clientId ||
    config.clientSecret.length > 16384 ||
    config.scope.length > 2048 ||
    !config.scope.split(/\s+/).includes("openid")
  )
    throw new Error("Invalid configured OIDC client");
  if (config.organization) assertOidcOrganization(config.organization);
}
function authenticationMethod(
  config: ConfiguredOidc,
  advertised: BoundaryValue | undefined,
): Discovery["authentication"] {
  if (
    advertised !== undefined &&
    (!Array.isArray(advertised) ||
      !advertised.length ||
      advertised.length > 32 ||
      advertised.some((value) => !isString(value)))
  )
    throw new Error("Invalid OIDC token authentication metadata");
  const methods = Array.isArray(advertised)
    ? advertised
    : ["client_secret_basic"];
  let authentication: Discovery["authentication"] = "none";
  if (config.clientSecret) {
    if (methods.includes("client_secret_basic"))
      authentication = "client_secret_basic";
    else if (methods.includes("client_secret_post"))
      authentication = "client_secret_post";
    else
      throw new Error(
        "Provider has no configured client-secret authentication method",
      );
  } else if (!methods.includes("none")) {
    throw new Error("Provider has no public-client authentication method");
  }
  return authentication;
}

function explicitAuthentication(
  config: ConfiguredOidc,
): Discovery["authentication"] | null {
  const chosen = config.authentication ?? "auto";
  if (chosen === "auto") return null;
  if ((chosen === "none") !== !config.clientSecret)
    throw new Error(
      "Match the token authentication method to the configured client secret",
    );
  return chosen;
}
export async function assertOidcKeyEndpoint(
  fetchImpl: typeof fetch,
  jwksUri: string,
): Promise<void> {
  const keys = await fetchOidcJson(fetchImpl, jwksUri);
  if (!Array.isArray(keys.keys) || !keys.keys.length || keys.keys.length > 64)
    throw new Error(
      "The configured JWKS endpoint has no bounded signing key set",
    );
}
function assertDiscoveredCodeFlow(
  document: Awaited<ReturnType<typeof fetchOidcJson>>,
): void {
  for (const [key, required] of [
    ["response_types_supported", "code"],
    ["code_challenge_methods_supported", "S256"],
  ] as const) {
    const advertised = document[key];
    if (
      advertised !== undefined &&
      (!Array.isArray(advertised) || !advertised.includes(required))
    )
      throw new Error(
        "OIDC provider does not advertise authorization code with S256 PKCE",
      );
  }
}
export async function discoverConfiguredOidc(
  config: ConfiguredOidc,
  fetchImpl: typeof fetch,
): Promise<Discovery> {
  const overrides = config.endpoints;
  const explicit = explicitAuthentication(config);
  if (
    overrides?.authorizationEndpoint &&
    overrides.tokenEndpoint &&
    overrides.jwksUri
  ) {
    if (!explicit)
      throw new Error(
        "Select token authentication when supplying all OIDC endpoints",
      );
    return Object.freeze({
      issuer: config.issuer,
      authorizationEndpoint: endpoint(overrides.authorizationEndpoint),
      tokenEndpoint: endpoint(overrides.tokenEndpoint),
      jwksUri: endpoint(overrides.jwksUri),
      authentication: explicit,
      manual: true,
    });
  }
  const document = await fetchOidcJson(
    fetchImpl,
    `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  );
  if (document.issuer !== config.issuer)
    throw new Error(
      "OIDC discovery does not exactly match the configured issuer",
    );
  assertDiscoveredCodeFlow(document);
  return Object.freeze({
    issuer: config.issuer,
    authorizationEndpoint: endpoint(
      overrides?.authorizationEndpoint || document.authorization_endpoint,
    ),
    tokenEndpoint: endpoint(
      overrides?.tokenEndpoint || document.token_endpoint,
    ),
    jwksUri: endpoint(overrides?.jwksUri || document.jwks_uri),
    authentication:
      explicit ??
      authenticationMethod(
        config,
        document.token_endpoint_auth_methods_supported,
      ),
    manual: false,
  });
}
