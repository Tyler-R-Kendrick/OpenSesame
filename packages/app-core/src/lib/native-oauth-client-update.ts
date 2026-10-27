/** Saved OAuth edits retain only the exact originally consented vault credential and binding. */
import { sha256Base64Url } from "@opensesame/sdk-browser";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  type NativeConfiguration,
  type NativeFieldClassification,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  assertVaultCredentials,
  discardUnpublishedVaultCredentials,
  readVaultCredentials,
  stageVaultCredentials,
} from "./vault-credential-custody.js";

type Update = {
  input: NativeDriverInput;
  desired: NativeConfiguration;
  owner: NativeOAuthClientOwner;
  secret: string | undefined;
  fingerprint(configuration: NativeConfiguration): Promise<string>;
  classification: NativeFieldClassification;
  check(): void;
  readSecret(id: string): string | undefined;
};
function existing(input: NativeDriverInput) {
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
      Object.keys(old.privateState.pending).length ||
      old.privateState.recovery.length)
  )
    throw new NativeOAuthError("cleanup");
  return old;
}
async function retain(update: Update, old: NativeConnectorRecord) {
  const { desired, owner, check, secret } = update;
  const binding = await update.fingerprint(old.configuration);
  check();
  if (
    binding !== old.configuration.fingerprint ||
    binding !== desired.fingerprint
  )
    throw new NativeOAuthError("cleanup");
  const heldSecret = update.readSecret(old.connectionId);
  if (secret !== undefined && secret !== heldSecret)
    throw new NativeOAuthError("cleanup");
  const held = readVaultCredentials(
    old.privateState.credentials.oauth_client_reference ?? "",
    binding,
    ["clientSecret"],
    owner.tomb,
  );
  const assertRetained = () => {
    check();
    assertVaultCredentials(held, owner.tomb, check);
    const view = readNativeConnector(old.connectionId);
    if (
      view?.revision !== old.revision ||
      view.fingerprint !== binding ||
      view.status !== "connected"
    )
      throw new NativeOAuthError("expired");
  };
  assertRetained();
  const consent = old.privateState.credentials.oauth_client_consent?.split(":");
  const digest = await sha256Base64Url(heldSecret ?? "");
  assertRetained();
  if (consent?.length !== 2 || !consent[0] || consent[1] !== digest)
    throw new NativeOAuthError("expired");
  if (
    desired.displayName === old.configuration.displayName &&
    desired.icon === old.configuration.icon
  ) {
    await assertNativeConnectorRevision(
      old.connectionId,
      nativeOAuthGuard(old),
    );
    assertRetained();
    const view = readNativeConnector(old.connectionId);
    if (!view) throw new NativeOAuthError("expired");
    return view;
  }
  return updateNativeConnector(
    old.connectionId,
    nativeOAuthGuard(old),
    update.classification,
    (current) => {
      assertRetained();
      current.configuration.displayName = desired.displayName;
      current.configuration.icon = desired.icon;
      return current;
    },
    assertRetained,
  );
}
export async function saveNativeOAuthClientConfiguration(update: Update) {
  const { input, desired, owner, secret, check, classification } = update;
  check();
  const old = existing(input);
  if (old && Object.keys(old.privateState.grants).length)
    return retain(update, old);
  if ((desired.parameters.token_auth_method === "none") === Boolean(secret))
    throw new NativeOAuthError("callback");
  const captured = await stageVaultCredentials(
    {
      name: desired.displayName,
      targetBinding: desired.fingerprint,
      fields: secret
        ? [
            {
              field: "clientSecret",
              label: "OAuth client secret",
              value: secret,
            },
          ]
        : [],
    },
    owner.tomb,
    check,
  );
  const assertCaptured = () => {
    check();
    assertVaultCredentials(captured, owner.tomb, check);
  };
  const state = emptyNativePrivate();
  state.credentials = {
    oauth_client_reference: captured.reference,
    oauth_client_vault: owner.tomb,
  };
  if (
    old &&
    old.privateState.credentials.oauth_client_reference !== captured.reference
  )
    state.recovery.push({
      id: `oauth-client-cleanup:${old.revision}`,
      kind: "revoke",
      providerId: old.configuration.providerId,
      actor: "user",
      fingerprint: old.configuration.fingerprint,
      targetId: old.configuration.clientId ?? old.configuration.providerId,
      credentials: {
        phase: "superseded",
        oauth_client_reference:
          old.privateState.credentials.oauth_client_reference ?? "",
        oauth_client_vault:
          old.privateState.credentials.oauth_client_vault ?? "",
        oauth_client_binding: old.configuration.fingerprint,
      },
    });
  const connectionId = old?.connectionId ?? `devconn_${crypto.randomUUID()}`;
  let saved: Awaited<ReturnType<typeof saveNativeConnector>>;
  try {
    saved = old
      ? await updateNativeConnector(
          old.connectionId,
          nativeOAuthGuard(old),
          classification,
          (record) => {
            assertCaptured();
            record.configuration = desired;
            record.privateState = state;
            record.runtime = emptyNativeRuntime();
            return record;
          },
          assertCaptured,
        )
      : await saveNativeConnector(
          {
            connectionId,
            configuration: desired,
            runtime: emptyNativeRuntime(),
            privateState: state,
          },
          classification,
          assertCaptured,
        );
  } catch (error) {
    await discardUnpublishedVaultCredentials(
      captured,
      owner.tomb,
      () =>
        loadNativeConnectorRecord(connectionId)?.privateState.credentials
          .oauth_client_reference === captured.reference,
      check,
    );
    throw error;
  }
  return saved;
}
