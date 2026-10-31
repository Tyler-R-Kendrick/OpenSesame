/** Explicit OAuth targets share native records and real on-device credential custody. */
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { z } from "zod";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import type {
  NativeConfiguration,
  NativePending,
} from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { assertGoogleDriveAccountContract } from "./native-google-drive-account.js";
import { validateNativeMcpBinding } from "./native-mcp-target.js";
import { nativeOAuthProviderContract } from "./native-oauth-client-contract.js";
import { saveNativeOAuthClientConfiguration } from "./native-oauth-client-update.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  initializeVaultCredentialCustody,
  readVaultCredentials,
} from "./vault-credential-custody.js";

const secureUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  });
const secureEndpoint = secureUrl.refine((value) => !new URL(value).search);
export const NativeOAuthClientTarget = z
  .object({
    issuer: secureEndpoint,
    authorization_endpoint: secureEndpoint,
    token_endpoint: secureEndpoint,
    token_relay_url: secureUrl.optional(),
    resource: secureEndpoint.optional(),
    resource_protocol: z.enum(["json", "mcp"]).optional(),
    resource_parameter: z.enum(["send", "omit"]).optional(),
    mcp_endpoint: secureUrl.optional(),
    mcp_transport: z.enum(["streamable-http", "sse"]).optional(),
    mcp_post_endpoint: secureEndpoint.optional(),
    token_auth_method: z.enum([
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]),
  })
  .strict();
/** Empty optional form controls mean absence only at the incoming configuration boundary. */
export function normalizeNativeOAuthClientParameters(
  parameters: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parameters).filter(
      ([key, value]) =>
        // Sending the resource is what no setting at all means, so it is stored as none.
        !(key === "resource_parameter" && value === "send") &&
        (![
          "token_relay_url",
          "resource_protocol",
          "mcp_endpoint",
          "mcp_transport",
          "mcp_post_endpoint",
        ].includes(key) ||
          value !== ""),
    ),
  );
}
const PARAMETERS: string[] = [
  ...NativeOAuthClientTarget.keyof().options,
  "redirect_uri",
];
/** Optional target fields a form submits as "" when left empty. */
const BLANK_MEANS_ABSENT = [
  "token_relay_url",
  "resource_protocol",
  "mcp_transport",
  "mcp_post_endpoint",
  "mcp_endpoint",
];
/** Drop the optional fields left empty, so a blank one never fails the target's URL or enum rule. */
export function nativeOAuthClientParameters(
  supplied: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(supplied).filter(
      ([key, value]) => value !== "" || !BLANK_MEANS_ABSENT.includes(key),
    ),
  );
}
const CREDENTIALS = [
  "oauth_client_reference",
  "oauth_client_vault",
  "oauth_client_consent",
  "client_secret",
];
export {
  initializeVaultCredentialCustody as initializeNativeOAuthClientCustody,
};
const CLIENT_SECRET = z.string().min(1).max(32768);
export const nativeOAuthClientClassification = () => ({
  publicParameters: PARAMETERS,
  privateCredentials: CREDENTIALS,
});
export type NativeOAuthClientOwner = {
  tomb: string;
  redirectUri: string;
  transport: NativeProviderTransport;
};
export function assertNativeOAuthClientOwner(
  owner: NativeOAuthClientOwner,
): void {
  owner.transport.assertCurrent();
  owner.transport.signal?.throwIfAborted();
}
export function nativeOAuthClientTarget(configuration: NativeConfiguration) {
  const { redirect_uri, ...parameters } = configuration.parameters;
  const target = NativeOAuthClientTarget.parse(parameters);
  if (
    configuration.method !== "oauth" ||
    !configuration.clientId ||
    !redirect_uri
  )
    throw new NativeOAuthError("callback");
  if (target.resource_protocol === "mcp") {
    if (target.mcp_transport === "sse" && !target.mcp_post_endpoint)
      throw new NativeOAuthError("callback");
    validateNativeMcpBinding({
      providerId: configuration.providerId,
      fingerprint: configuration.fingerprint,
      resource: target.resource ?? "",
      endpoint: target.mcp_endpoint ?? target.resource ?? "",
      issuer: target.issuer,
      transport: target.mcp_transport ?? "streamable-http",
      ssePostEndpoint: target.mcp_post_endpoint,
    });
  } else if (
    target.mcp_endpoint ||
    target.mcp_transport ||
    target.mcp_post_endpoint
  )
    throw new NativeOAuthError("callback");
  return {
    ...target,
    redirectUri: redirect_uri,
    clientId: configuration.clientId,
  };
}
/** Both fingerprinted targets must be covered by this one captured original carrier. */
export function assertNativeOAuthClientPolicy(
  configuration: NativeConfiguration,
  owner: NativeOAuthClientOwner,
) {
  assertNativeOAuthClientOwner(owner);
  const target = nativeOAuthClientTarget(configuration);
  assertNativeBrowserOAuthPolicy(configuration.providerId, {
    transport: owner.transport,
    tokenEndpoint: target.token_endpoint,
    resourceEndpoint: target.resource ?? "",
  });
  assertGoogleDriveAccountContract(configuration);
  assertNativeOAuthClientOwner(owner);
  return target;
}
function callbackUri(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new NativeOAuthError("callback");
  return url.href;
}
async function configuration(
  input: NativeDriverInput,
  owner: NativeOAuthClientOwner,
): Promise<NativeConfiguration> {
  const { client_id, ...supplied } = input.parameters;
  const parameters = normalizeNativeOAuthClientParameters(supplied);
  NativeOAuthClientTarget.parse(parameters);
  if (
    input.method !== "oauth" ||
    !client_id ||
    Object.keys(input.targetIds).length ||
    Object.keys(input.requestedScopes).some((actor) => actor !== "user")
  )
    throw new NativeOAuthError("callback");
  const scopes = z
    .array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,512}$/))
    .max(256)
    .parse(input.requestedScopes.user ?? []);
  const result: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "oauth",
    displayName: input.displayName,
    icon: input.icon ?? "",
    parameters: { ...parameters, redirect_uri: callbackUri(owner.redirectUri) },
    clientId: client_id,
    requestedScopes: { user: [...new Set(scopes)] },
    targetIds: {},
    fingerprint: "0".repeat(64),
  };
  result.fingerprint = await nativeOAuthClientFingerprint(result);
  return result;
}
async function nativeOAuthClientFingerprint(
  result: NativeConfiguration,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      result.providerId,
      result.method,
      nativeOAuthClientTarget(result),
      result.requestedScopes,
    ]),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
export function readNativeOAuthClientSecret(
  id: string,
  owner: NativeOAuthClientOwner,
): string | undefined {
  assertNativeOAuthClientOwner(owner);
  const record = requireNativeOAuthRecord(id);
  const target = nativeOAuthClientTarget(record.configuration);
  if (target.redirectUri !== callbackUri(owner.redirectUri))
    throw new NativeOAuthError("expired");
  if (record.privateState.credentials.oauth_client_vault !== owner.tomb)
    throw new NativeOAuthError("expired");
  const held = readVaultCredentials(
    record.privateState.credentials.oauth_client_reference ?? "",
    record.configuration.fingerprint,
    ["clientSecret"],
    owner.tomb,
  );
  if (target.token_auth_method === "none") {
    if (held.fields.size) throw new NativeOAuthError("expired");
    return undefined;
  }
  return CLIENT_SECRET.parse(held.fields.get("clientSecret"));
}
export async function configureNativeOAuthClient(
  input: NativeDriverInput,
  owner: NativeOAuthClientOwner,
) {
  assertNativeOAuthClientOwner(owner);
  const desired = await configuration(input, owner);
  const check = () => {
    assertNativeOAuthClientPolicy(desired, owner);
  };
  check();
  const credentials = z
    .object({
      client_secret: z.union([CLIENT_SECRET, z.literal("")]).optional(),
    })
    .strict()
    .parse(input.credentials);
  return saveNativeOAuthClientConfiguration({
    input,
    desired,
    owner,
    secret: credentials.client_secret || undefined,
    fingerprint: nativeOAuthClientFingerprint,
    classification: nativeOAuthClientClassification(),
    check,
    readSecret: (id) => readNativeOAuthClientSecret(id, owner),
  });
}
export async function beginNativeOAuthClient(
  id: string,
  owner: NativeOAuthClientOwner,
): Promise<string> {
  assertNativeOAuthClientOwner(owner);
  await initializeVaultCredentialCustody();
  assertNativeOAuthClientOwner(owner);
  const record = requireNativeOAuthRecord(id);
  const target = assertNativeOAuthClientPolicy(record.configuration, owner);
  const secret = readNativeOAuthClientSecret(id, owner);
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new NativeOAuthError("cleanup");
  const verifier = randomString(32);
  const state = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  const credentialDigest = await sha256Base64Url(secret ?? "");
  const now = Date.now();
  const pending: NativePending = {
    providerId: record.configuration.providerId,
    actor: "user",
    fingerprint: record.configuration.fingerprint,
    issuer: target.issuer,
    endpoint: target.token_endpoint,
    resource: target.resource,
    clientId: target.clientId,
    state,
    verifier,
    redirectUri: target.redirectUri,
    scopes: record.configuration.requestedScopes.user ?? [],
    createdAt: now,
    expiresAt: now + 600_000,
  };
  const contract = nativeOAuthProviderContract(record.configuration.providerId);
  const url = new URL(target.authorization_endpoint);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: target.clientId,
    redirect_uri: pending.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  // A provider that takes no scopes (Notion) is not sent an empty one.
  if (pending.scopes.length)
    query.set("scope", pending.scopes.join(contract.scopeSeparator));
  // What the provider's authorization endpoint requires of its own contract
  // (Atlassian's audience, Notion's owner); never a name this flow already set.
  for (const [name, value] of Object.entries(contract.authorizationParams))
    if (!query.has(name)) query.set(name, value);
  if (target.resource && target.resource_parameter !== "omit")
    query.set("resource", target.resource);
  url.search = query.toString();
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeOAuthClientClassification(),
    (current) => {
      assertNativeOAuthClientOwner(owner);
      if (readNativeOAuthClientSecret(id, owner) !== secret)
        throw new NativeOAuthError("expired");
      current.privateState.credentials.oauth_client_consent = `${state}:${credentialDigest}`;
      current.privateState.pending.user = pending;
      current.privateState.verification = null;
      return current;
    },
    () => assertNativeOAuthClientOwner(owner),
  );
  assertNativeOAuthClientOwner(owner);
  return url.href;
}
