/**
 * Generic OIDC ambient request: authorization code + PKCE S256 + nonce.
 * Shoo is never sent through this path.
 */

import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type VerifiedIdTokenClaims,
  createPkcePair,
  randomString,
  verifyBrowserIdTokenClaims,
} from "@opensesame/sdk-browser";
import { FederationError, type UpstreamIdentity } from "../federation.js";
import { currentAuthGeneration } from "./generation.js";
import {
  type ProviderConnection,
  applyPromptParams,
  normalizePrompt,
} from "./provider.js";
import {
  type FederationTransaction,
  TX_MAX_AGE_MS,
  createTransaction,
  persistTransaction,
} from "./transactions.js";
import type { AmbientTransport, AuthenticationIntent } from "./types.js";

export const AMBIENT_SCOPES = "openid";

export type AmbientAuthorizeRequest = {
  url: string;
  transaction: FederationTransaction;
};

export async function beginAmbientOidc(input: {
  connection: ProviderConnection;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  redirectUri: string;
  intent: Extract<AuthenticationIntent, { kind: "ambient" }>;
  transport: AmbientTransport;
  policyRevision: string;
  now?: number;
}): Promise<AmbientAuthorizeRequest> {
  if (input.connection.protocol === "shoo") {
    throw new FederationError(
      "unsupported",
      "Shoo does not support automatic acquisition.",
    );
  }
  const prompt = normalizePrompt({
    intent: input.intent,
    transport: input.transport,
    protocol: input.connection.protocol,
  });
  if (!prompt.ok) {
    throw new FederationError(
      "unsupported",
      "Automatic acquisition is not supported.",
    );
  }
  const pkce = await createPkcePair();
  const verifier = pkce.codeVerifier;
  const challenge = pkce.codeChallenge;
  const state = pkce.state;
  const nonce = pkce.nonce;
  const now = input.now ?? Date.now();
  const transaction = createTransaction({
    transactionId: randomString(16),
    state,
    nonce,
    verifier,
    createdAt: now,
    expiresAt: now + TX_MAX_AGE_MS,
    issuer: input.connection.issuer,
    clientId: input.connection.clientId,
    redirectUri: input.redirectUri,
    tokenEndpoint: input.tokenEndpoint,
    jwksUri: input.jwksUri,
    intent: input.intent,
    policyRevision: input.policyRevision,
    generation: currentAuthGeneration(),
    providerKey: input.connection.key,
    transport: input.transport,
  });
  persistTransaction(transaction);

  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.connection.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", AMBIENT_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  applyPromptParams(url.searchParams, prompt.prompt);
  return { url: url.toString(), transaction };
}

export async function exchangeAmbientCode(
  transaction: FederationTransaction,
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ identity: UpstreamIdentity; claims: VerifiedIdTokenClaims }> {
  if (transaction.intent.kind !== "ambient") {
    throw new FederationError("invalid_request", "Not an ambient transaction.");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: transaction.redirectUri,
    client_id: transaction.clientId,
    code_verifier: transaction.verifier,
  });
  let response: Response;
  try {
    response = await fetchImpl(transaction.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      credentials: "omit",
    });
  } catch {
    throw new FederationError(
      "upstream_unavailable",
      "Could not reach the token endpoint.",
    );
  }
  if (!response.ok) {
    throw new FederationError("exchange_failed", "Token exchange refused.");
  }
  const tokens: BoundaryValue = overlapCast(await response.json());
  if (!isJsonObject(tokens) || !isString(tokens.id_token)) {
    throw new FederationError("exchange_failed", "No id_token.");
  }
  const claims = await verifyBrowserIdTokenClaims({
    token: tokens.id_token,
    nonce: transaction.nonce,
    issuer: transaction.issuer,
    clientId: transaction.clientId,
    jwksUri: transaction.jwksUri,
    fetchImpl,
  });
  const identity: UpstreamIdentity = {
    issuer: claims.iss,
    upstreamId: transaction.providerKey,
    idToken: tokens.id_token,
    pairwiseSub: claims.sub,
    audience: transaction.clientId,
    jwksUri: transaction.jwksUri,
    expiresAt: claims.exp * 1000,
    ...(claims.email ? { email: claims.email } : undefined),
    ...(claims.name ? { name: claims.name } : undefined),
  };
  return { identity, claims };
}
