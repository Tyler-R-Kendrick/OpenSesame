/** An operator's sealed OAuth secret is spent only at its original discovered token endpoint. */
import { isString } from "@opensesame/os-domain";
import { createPkcePair, fetchOidcJson } from "@opensesame/sdk-browser";
import { identityEndpoint } from "../../lib/identity-connections-schema.js";
import type { ConfiguredOidc } from "../../lib/identity-oidc-config.js";
import type { NativeProviderTransport } from "../../lib/native-connector-transport.js";
import { type OidcOwner, verifyNativeOidcProof } from "./claims.js";

import {
  type Discovery,
  assertConfiguredOidc,
  assertOidcKeyEndpoint,
  discoverConfiguredOidc,
} from "./discovery.js";

export type { ConfiguredOidc } from "../../lib/identity-oidc-config.js";
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

function snapshotOidcConfiguration(input: ConfiguredOidc): ConfiguredOidc {
  return Object.freeze({
    ...input,
    organization:
      input.organization && Object.freeze({ ...input.organization }),
    endpoints: input.endpoints && Object.freeze({ ...input.endpoints }),
  });
}

function configuredAuthorizationUrl(
  config: ConfiguredOidc,
  discovery: Discovery,
  redirectUri: string,
  pair: Awaited<ReturnType<typeof createPkcePair>>,
): URL {
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
  return url;
}
export async function prepareConfiguredOidc(
  input: ConfiguredOidc,
  redirectUri: string,
  source: NativeProviderTransport,
  original: OidcOwner,
) {
  const config = snapshotOidcConfiguration(input);
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
  assertConfiguredOidc(config);
  if (!identityEndpoint(redirectUri))
    throw new Error("Invalid OIDC redirect URI");
  const fetchImpl = guardedFetch(transport, owner);
  const discovery = await discoverConfiguredOidc(config, fetchImpl);
  routes.bind(discovery);
  owner.assertCurrent();
  if (discovery.manual) {
    await assertOidcKeyEndpoint(fetchImpl, discovery.jwksUri);
    owner.assertCurrent();
  }
  const pair = await createPkcePair();
  owner.assertCurrent();
  const url = configuredAuthorizationUrl(config, discovery, redirectUri, pair);
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
    manualEndpoints: discovery.manual,
    authorizationUrl: url.href,
    state: pair.state,
    expiresAt,
    complete,
  });
}
