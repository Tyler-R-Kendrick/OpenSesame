/** Explicit OAuth targets share native records and real on-device credential custody. */
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { z } from "zod";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  type NativeConfiguration,
  type NativePending,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  assertVaultCredentials,
  discardVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
  stageVaultCredentials,
} from "./vault-credential-custody.js";

const secureEndpoint = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
export const NativeOAuthClientTarget = z
  .object({
    issuer: secureEndpoint,
    authorization_endpoint: secureEndpoint,
    token_endpoint: secureEndpoint,
    resource: secureEndpoint.optional(),
    resource_protocol: z.enum(["json", "mcp"]).optional(),
    token_auth_method: z.enum([
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]),
  })
  .strict();
const PARAMETERS: string[] = [
  ...NativeOAuthClientTarget.keyof().options,
  "redirect_uri",
];
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
  const parameters = Object.fromEntries(
    Object.entries(supplied).filter(
      ([key, value]) => key !== "resource_protocol" || value !== "",
    ),
  );
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
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      result.providerId,
      result.method,
      nativeOAuthClientTarget(result),
      result.requestedScopes,
    ]),
  );
  result.fingerprint = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return result;
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
function existingConfiguration(input: NativeDriverInput) {
  const old = input.connectionId
    ? loadNativeConnectorRecord(input.connectionId)
    : null;
  if (
    input.connectionId &&
    (!old ||
      old.configuration.providerId !== input.providerId ||
      old.revision !== input.revision)
  )
    throw new NativeOAuthError("expired");
  if (
    old &&
    (old.configuration.method !== "oauth" ||
      Object.keys(old.privateState.grants).length ||
      Object.keys(old.privateState.pending).length ||
      old.privateState.recovery.length)
  )
    throw new NativeOAuthError("cleanup");
  return old;
}
export async function configureNativeOAuthClient(
  input: NativeDriverInput,
  owner: NativeOAuthClientOwner,
) {
  assertNativeOAuthClientOwner(owner);
  const desired = await configuration(input, owner);
  assertNativeOAuthClientOwner(owner);
  const target = assertNativeOAuthClientPolicy(desired, owner);
  const credentials = z
    .object({ client_secret: CLIENT_SECRET.optional() })
    .strict()
    .parse(input.credentials);
  if (
    (target.token_auth_method === "none") ===
    Boolean(credentials.client_secret)
  )
    throw new NativeOAuthError("callback");
  const old = existingConfiguration(input);
  const captured = await stageVaultCredentials(
    {
      name: desired.displayName,
      targetBinding: desired.fingerprint,
      fields: credentials.client_secret
        ? [
            {
              field: "clientSecret",
              label: "OAuth client secret",
              value: credentials.client_secret,
            },
          ]
        : [],
    },
    owner.tomb,
    () => assertNativeOAuthClientOwner(owner),
  );
  const check = () => {
    assertNativeOAuthClientOwner(owner);
    assertVaultCredentials(captured, owner.tomb, owner.transport.assertCurrent);
  };
  const state = emptyNativePrivate();
  state.credentials = {
    oauth_client_reference: captured.reference,
    oauth_client_vault: owner.tomb,
  };
  try {
    if (!old)
      return await saveNativeConnector(
        {
          connectionId: `devconn_${crypto.randomUUID()}`,
          configuration: desired,
          runtime: emptyNativeRuntime(),
          privateState: state,
        },
        nativeOAuthClientClassification(),
        check,
      );
    return await updateNativeConnector(
      old.connectionId,
      nativeOAuthGuard(old),
      nativeOAuthClientClassification(),
      (record) => {
        check();
        record.configuration = desired;
        record.privateState = state;
        record.runtime = emptyNativeRuntime();
        return record;
      },
      check,
    );
  } catch (error) {
    await discardVaultCredentials(captured, owner.tomb, () =>
      assertNativeOAuthClientOwner(owner),
    );
    throw error;
  }
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
  const url = new URL(target.authorization_endpoint);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: target.clientId,
    redirect_uri: pending.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: pending.scopes.join(" "),
  });
  if (target.resource) query.set("resource", target.resource);
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
