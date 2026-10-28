import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { z } from "zod";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import type {
  NativeConfiguration,
  NativePending,
} from "./native-connector-schema.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  ORIGIN_PROVIDER_ID,
  supersededNativeOriginRecovery,
} from "./native-origin-cleanup.js";
import {
  assertVaultCredentials,
  discardUnpublishedVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
  stageVaultCredentials,
} from "./vault-credential-custody.js";

export { initializeVaultCredentialCustody as initializeNativeOriginCustody };
export { ORIGIN_PROVIDER_ID } from "./native-origin-cleanup.js";
export const ORIGIN_ISSUER = "https://api.cursor.com/v1/origin";
export const ORIGIN_INSTALL_URL = "https://cursor.com/codebase/apps/install";
export const ORIGIN_TOKEN_BASE = `${ORIGIN_ISSUER}/app/installations`;
export const ORIGIN_RATE_LIMIT_URL = `${ORIGIN_ISSUER}/rate_limit`;
export const ORIGIN_DISCOVERY_URL = `${ORIGIN_ISSUER}/.well-known/openid-configuration`;
export const ORIGIN_JWKS_URL = `${ORIGIN_ISSUER}/keys`;
const Target = z
  .object({
    issuer: z.literal(ORIGIN_ISSUER),
    authorization_endpoint: z.literal(ORIGIN_INSTALL_URL),
    token_endpoint: z.literal(ORIGIN_TOKEN_BASE),
    resource: z.literal(ORIGIN_RATE_LIMIT_URL),
    discovery_url: z.literal(ORIGIN_DISCOVERY_URL),
    jwks_uri: z.literal(ORIGIN_JWKS_URL),
  })
  .strict();
const PARAMETERS = [...Target.keyof().options, "redirect_uri"];
const CREDENTIALS = [
  "origin_app_reference",
  "origin_app_vault",
  "origin_app_consent",
  "origin_app_binding",
];
const appId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7E]+$/);
const scope = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,512}$/);
export type NativeOriginOwner = NativeOAuthClientOwner;
export const nativeOriginClassification = () => ({
  publicParameters: PARAMETERS,
  privateCredentials: CREDENTIALS,
});
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
export function nativeOriginTarget(configuration: NativeConfiguration) {
  const { redirect_uri, ...parameters } = configuration.parameters;
  const target = Target.parse(parameters);
  if (
    configuration.providerId !== ORIGIN_PROVIDER_ID ||
    configuration.method !== "oauth" ||
    !configuration.clientId ||
    !redirect_uri
  )
    throw new NativeOAuthError("callback");
  return {
    ...target,
    clientId: appId.parse(configuration.clientId),
    redirectUri: callbackUri(redirect_uri),
  };
}
export function assertNativeOriginPolicy(
  configuration: NativeConfiguration,
  owner: NativeOriginOwner,
  tokenEndpoint?: string,
): void {
  owner.transport.assertCurrent();
  owner.transport.signal?.throwIfAborted();
  const target = nativeOriginTarget(configuration);
  assertNativeBrowserOAuthPolicy(configuration.providerId, {
    transport: owner.transport,
    tokenEndpoint: tokenEndpoint ?? target.token_endpoint,
    resourceEndpoint: target.resource,
  });
  owner.transport.assertCurrent();
}
export async function importNativeOriginPrivateKey(
  pem: string,
): Promise<CryptoKey> {
  const match =
    /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)-----END PRIVATE KEY-----\s*$/.exec(
      pem,
    );
  if (!match || pem.length > 32768) throw new NativeOAuthError("callback");
  try {
    const der = Uint8Array.from(atob(match[1].replace(/\s/g, "")), (c) =>
      c.charCodeAt(0),
    );
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    throw new NativeOAuthError("callback");
  }
}
export function readNativeOriginPrivateKey(
  id: string,
  owner: NativeOriginOwner,
): string {
  assertNativeOriginPolicy(requireNativeOAuthRecord(id).configuration, owner);
  const record = requireNativeOAuthRecord(id);
  const target = nativeOriginTarget(record.configuration);
  if (
    target.redirectUri !== callbackUri(owner.redirectUri) ||
    record.privateState.credentials.origin_app_vault !== owner.tomb
  )
    throw new NativeOAuthError("expired");
  return z
    .string()
    .min(1)
    .max(32768)
    .parse(
      readVaultCredentials(
        record.privateState.credentials.origin_app_reference ?? "",
        record.configuration.fingerprint,
        ["appPrivateKey"],
        owner.tomb,
      ).fields.get("appPrivateKey"),
    );
}
async function fingerprint(
  configuration: NativeConfiguration,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      nativeOriginTarget(configuration),
      configuration.requestedScopes,
    ]),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
async function desiredConfiguration(
  input: NativeDriverInput,
  owner: NativeOriginOwner,
): Promise<NativeConfiguration> {
  if (
    input.providerId !== ORIGIN_PROVIDER_ID ||
    input.method !== "oauth" ||
    Object.keys(input.targetIds).length ||
    Object.keys(input.requestedScopes).some((actor) => actor !== "user")
  )
    throw new NativeOAuthError("callback");
  const { client_id, redirect_uri, ...parameters } = input.parameters;
  if (
    Object.keys(parameters).length ||
    (redirect_uri !== undefined &&
      callbackUri(redirect_uri) !== callbackUri(owner.redirectUri))
  )
    throw new NativeOAuthError("callback");
  const scopes = z
    .array(scope)
    .max(256)
    .parse(input.requestedScopes.user ?? []);
  const result: NativeConfiguration = {
    version: 1,
    providerId: ORIGIN_PROVIDER_ID,
    method: "oauth",
    displayName: input.displayName,
    icon: input.icon ?? "",
    parameters: {
      issuer: ORIGIN_ISSUER,
      authorization_endpoint: ORIGIN_INSTALL_URL,
      token_endpoint: ORIGIN_TOKEN_BASE,
      resource: ORIGIN_RATE_LIMIT_URL,
      discovery_url: ORIGIN_DISCOVERY_URL,
      jwks_uri: ORIGIN_JWKS_URL,
      redirect_uri: callbackUri(owner.redirectUri),
    },
    clientId: appId.parse(client_id),
    requestedScopes: { user: [...new Set(scopes)] },
    targetIds: {},
    fingerprint: "0".repeat(64),
  };
  result.fingerprint = await fingerprint(result);
  return result;
}
function existing(input: NativeDriverInput) {
  const old = input.connectionId
    ? loadNativeConnectorRecord(input.connectionId)
    : null;
  if (
    input.connectionId &&
    (!old ||
      old.configuration.providerId !== ORIGIN_PROVIDER_ID ||
      old.revision !== input.revision)
  )
    throw new NativeOAuthError("expired");
  if (
    old &&
    (Object.keys(old.privateState.pending).length ||
      old.privateState.recovery.length)
  )
    throw new NativeOAuthError("cleanup");
  return old;
}
export async function configureNativeOrigin(
  input: NativeDriverInput,
  owner: NativeOriginOwner,
) {
  const desired = await desiredConfiguration(input, owner);
  const credentials = z
    .object({ private_key: z.string().max(32768) })
    .strict()
    .parse(input.credentials);
  const old = existing(input);
  const privateKey =
    credentials.private_key ||
    (old ? readNativeOriginPrivateKey(old.connectionId, owner) : "");
  await importNativeOriginPrivateKey(privateKey);
  assertNativeOriginPolicy(desired, owner);
  if (old && Object.keys(old.privateState.grants).length) {
    if (
      old.configuration.fingerprint !== desired.fingerprint ||
      readNativeOriginPrivateKey(old.connectionId, owner) !== privateKey
    )
      throw new NativeOAuthError("cleanup");
    return updateNativeConnector(
      old.connectionId,
      nativeOAuthGuard(old),
      nativeOriginClassification(),
      (current) => {
        current.configuration.displayName = desired.displayName;
        current.configuration.icon = desired.icon;
        return current;
      },
      () => assertNativeOriginPolicy(desired, owner),
    );
  }
  const check = () => assertNativeOriginPolicy(desired, owner);
  const captured = await stageVaultCredentials(
    {
      name: desired.displayName,
      targetBinding: desired.fingerprint,
      fields: [
        {
          field: "appPrivateKey",
          label: "Cursor Origin app private key",
          value: privateKey,
        },
      ],
    },
    owner.tomb,
    check,
  );
  const state = emptyNativePrivate();
  state.credentials = {
    origin_app_reference: captured.reference,
    origin_app_vault: owner.tomb,
  };
  if (old) state.recovery.push(supersededNativeOriginRecovery(old));
  const connectionId = old?.connectionId ?? `devconn_${crypto.randomUUID()}`;
  let saved: Awaited<ReturnType<typeof saveNativeConnector>>;
  try {
    saved = old
      ? await updateNativeConnector(
          old.connectionId,
          nativeOAuthGuard(old),
          nativeOriginClassification(),
          (current) => {
            assertVaultCredentials(captured, owner.tomb, check);
            current.configuration = desired;
            current.privateState = state;
            current.runtime = emptyNativeRuntime();
            return current;
          },
          () => assertVaultCredentials(captured, owner.tomb, check),
        )
      : await saveNativeConnector(
          {
            connectionId,
            configuration: desired,
            runtime: emptyNativeRuntime(),
            privateState: state,
          },
          nativeOriginClassification(),
          () => assertVaultCredentials(captured, owner.tomb, check),
        );
  } catch (error) {
    await discardUnpublishedVaultCredentials(
      captured,
      owner.tomb,
      () =>
        loadNativeConnectorRecord(connectionId)?.privateState.credentials
          .origin_app_reference === captured.reference,
      check,
    );
    throw error;
  }
  return saved;
}
export async function beginNativeOrigin(
  id: string,
  owner: NativeOriginOwner,
): Promise<string> {
  await initializeVaultCredentialCustody();
  const record = requireNativeOAuthRecord(id);
  const target = nativeOriginTarget(record.configuration);
  assertNativeOriginPolicy(record.configuration, owner);
  const privateKey = readNativeOriginPrivateKey(id, owner);
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new NativeOAuthError("cleanup");
  const state = randomString(32);
  const credentialDigest = await sha256Base64Url(privateKey);
  const now = Date.now();
  const pending: NativePending = {
    providerId: ORIGIN_PROVIDER_ID,
    actor: "user",
    fingerprint: record.configuration.fingerprint,
    issuer: target.issuer,
    endpoint: target.token_endpoint,
    resource: target.resource,
    clientId: target.clientId,
    state,
    verifier: "",
    redirectUri: target.redirectUri,
    scopes: record.configuration.requestedScopes.user ?? [],
    createdAt: now,
    expiresAt: now + 300_000,
  };
  const url = new URL(target.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: target.clientId,
    scope: pending.scopes.join(" "),
    redirect_uri: target.redirectUri,
    state,
    include_granted_scopes: "true",
  }).toString();
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeOriginClassification(),
    (current) => {
      if (readNativeOriginPrivateKey(id, owner) !== privateKey)
        throw new NativeOAuthError("expired");
      current.privateState.credentials.origin_app_consent = `${state}:${credentialDigest}`;
      current.privateState.pending.user = pending;
      current.privateState.verification = null;
      return current;
    },
    () => assertNativeOriginPolicy(record.configuration, owner),
  );
  return url.href;
}
