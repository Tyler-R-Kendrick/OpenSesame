/** An operator's sealed OAuth secret is spent only at its original discovered token endpoint. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { createPkcePair, fetchOidcJson } from "@opensesame/sdk-browser";
import { identityEndpoint } from "../../lib/identity-connections-schema.js";
import type { NativeProviderTransport } from "../../lib/native-connector-transport.js";
import {
  type OidcOrganization,
  type OidcOwner,
  assertOidcOrganization,
  verifyNativeOidcProof,
} from "./claims.js";

export type ConfiguredOidc = Readonly<{
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  organization: OidcOrganization | null;
}>;
type Discovery = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  authentication: "none" | "client_secret_basic" | "client_secret_post";
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
function assertConfiguration(config: ConfiguredOidc): void {
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
/** Retain receiver-bound authority; replacement or reentry permanently retires it. */
function captureOidcAuthority(
  source: NativeProviderTransport,
  original: OidcOwner,
) {
  const fetch = source.fetch;
  const assert = source.assertCurrent;
  const signal = source.signal;
  const supports = source.supportsNativeOrigin;
  const ownerAssert = original.assertCurrent;
  const ownerSignal = original.signal;
  let retired = false;
  const unchanged = () => {
    if (source.supportsNativeOrigin !== supports)
      throw new Error("Original OIDC endpoint route changed");
    if (
      retired ||
      source.fetch !== fetch ||
      source.assertCurrent !== assert ||
      source.signal !== signal ||
      original.assertCurrent !== ownerAssert ||
      original.signal !== ownerSignal
    )
      throw new Error("Original OIDC authority changed");
  };
  const assertCurrent = () => {
    try {
      unchanged();
      ownerSignal.throwIfAborted();
      signal?.throwIfAborted();
      ownerAssert.call(original);
      unchanged();
      assert.call(source);
      unchanged();
      ownerSignal.throwIfAborted();
      signal?.throwIfAborted();
    } catch (error) {
      retired = true;
      throw error;
    }
  };
  const transport: NativeProviderTransport = {
    signal,
    assertCurrent,
    fetch: (input, init) => {
      assertCurrent();
      return fetch.call(source, input, init);
    },
  };
  if (supports)
    transport.supportsNativeOrigin = (origin) => {
      assertCurrent();
      const allowed = supports.call(source, origin);
      assertCurrent();
      return allowed;
    };
  return {
    transport: Object.freeze(transport),
    owner: Object.freeze({ signal: ownerSignal, assertCurrent }),
  };
}
function guardedFetch(
  transport: NativeProviderTransport,
  owner: OidcOwner,
): typeof fetch {
  return async (input, init) => {
    owner.assertCurrent();
    transport.assertCurrent();
    const signals = [owner.signal];
    if (transport.signal) signals.push(transport.signal);
    if (init?.signal) signals.push(init.signal);
    const response = await transport.fetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
    try {
      owner.assertCurrent();
      transport.assertCurrent();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  };
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
async function discover(config: ConfiguredOidc, fetchImpl: typeof fetch) {
  const document = await fetchOidcJson(
    fetchImpl,
    `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  );
  if (document.issuer !== config.issuer)
    throw new Error(
      "OIDC discovery does not exactly match the configured issuer",
    );
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
  return Object.freeze({
    issuer: config.issuer,
    authorizationEndpoint: endpoint(document.authorization_endpoint),
    tokenEndpoint: endpoint(document.token_endpoint),
    jwksUri: endpoint(document.jwks_uri),
    authentication: authenticationMethod(
      config,
      document.token_endpoint_auth_methods_supported,
    ),
  });
}
function encodedCredential(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}
async function exchange(
  code: string,
  config: ConfiguredOidc,
  discovery: Discovery,
  redirectUri: string,
  verifier: string,
  fetchImpl: typeof fetch,
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (discovery.authentication === "client_secret_basic") {
    headers.set(
      "authorization",
      `Basic ${btoa(`${encodedCredential(config.clientId)}:${encodedCredential(config.clientSecret)}`)}`,
    );
  } else if (discovery.authentication === "client_secret_post") {
    body.set("client_secret", config.clientSecret);
  }
  const tokens = await fetchOidcJson(fetchImpl, discovery.tokenEndpoint, {
    method: "POST",
    headers,
    body,
  });
  if (
    !isString(tokens.id_token) ||
    !tokens.id_token ||
    tokens.id_token.length > 16384
  )
    throw new Error("Configured OIDC provider returned no bounded ID token");
  return tokens.id_token;
}

/** A delegated endpoint needs affirmative approval on this same captured native route. */
function endpointRoutes(transport: NativeProviderTransport, issuer: string) {
  const supports = transport.supportsNativeOrigin;
  const original = new URL(issuer).origin;
  const origins = new Set([original]);
  let retired = false;
  return Object.freeze({
    bind(discovery: Discovery) {
      origins.add(new URL(discovery.tokenEndpoint).origin);
      origins.add(new URL(discovery.jwksUri).origin);
    },
    assertCurrent() {
      if (retired) throw new Error("Original OIDC endpoint route retired");
      try {
        if (transport.supportsNativeOrigin !== supports)
          throw new Error("Original OIDC endpoint route changed");
        for (const origin of origins) {
          if (
            (supports && supports.call(transport, origin) !== true) ||
            (!supports && origin !== original)
          )
            throw new Error(
              "Approve the discovered OIDC endpoint on the original native route",
            );
        }
        if (transport.supportsNativeOrigin !== supports)
          throw new Error("Original OIDC endpoint route changed");
        transport.assertCurrent();
        transport.signal?.throwIfAborted();
      } catch (error) {
        retired = true;
        throw error;
      }
    },
  });
}

export async function prepareConfiguredOidc(
  input: ConfiguredOidc,
  redirectUri: string,
  source: NativeProviderTransport,
  original: OidcOwner,
) {
  const config = Object.freeze({
    ...input,
    organization:
      input.organization && Object.freeze({ ...input.organization }),
  });
  const { transport, owner: originalOwner } = captureOidcAuthority(
    source,
    original,
  );
  const routes = endpointRoutes(transport, config.issuer);
  const expiresAt = Date.now() + 600_000;
  const owner: OidcOwner = Object.freeze({
    signal: originalOwner.signal,
    assertCurrent: () => {
      if (Date.now() >= expiresAt)
        throw new Error("OIDC original request expired");
      originalOwner.signal.throwIfAborted();
      transport.signal?.throwIfAborted();
      originalOwner.assertCurrent();
      transport.assertCurrent();
      routes.assertCurrent();
    },
  });
  owner.assertCurrent();
  assertConfiguration(config);
  if (!identityEndpoint(redirectUri))
    throw new Error("Invalid OIDC redirect URI");
  const fetchImpl = guardedFetch(transport, owner);
  const discovery = await discover(config, fetchImpl);
  routes.bind(discovery);
  owner.assertCurrent();
  const pair = await createPkcePair();
  owner.assertCurrent();
  const url = new URL(discovery.authorizationEndpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope,
    state: pair.state,
    nonce: pair.nonce,
    code_challenge: pair.codeChallenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  if (config.organization)
    url.searchParams.set(
      config.organization.authorizationParameter,
      config.organization.id,
    );
  let spent = false;
  const complete = async (
    response: Readonly<{ state: string; code: string | null; error: boolean }>,
  ) => {
    if (spent) throw new Error("OIDC transaction was already consumed");
    spent = true;
    owner.assertCurrent();
    if (
      Date.now() >= expiresAt ||
      response.state !== pair.state ||
      response.error ||
      !response.code ||
      response.code.length > 4096
    )
      throw new Error(
        "OIDC authorization response does not match its original request",
      );
    const token = await exchange(
      response.code,
      config,
      discovery,
      redirectUri,
      pair.codeVerifier,
      fetchImpl,
    );
    owner.assertCurrent();
    return verifyNativeOidcProof({
      token,
      issuer: config.issuer,
      clientId: config.clientId,
      nonce: pair.nonce,
      jwksUri: discovery.jwksUri,
      organization: config.organization,
      fetchImpl,
      owner,
    });
  };
  return Object.freeze({
    authorizationUrl: url.href,
    state: pair.state,
    expiresAt,
    complete,
  });
}
