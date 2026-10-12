/** Prepare a verified edit and construct the one atomic metadata/credential write. */
import type { DraftState } from "./connect-draft.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { verifyLinearAccount } from "./linear-api.js";
import { checkLinearWorkspace } from "./linear-consent-save.js";
import { removeLinearActor } from "./linear-revoke.js";
import {
  type LinearRuntime,
  linearConfiguration,
  linearFingerprint,
  linearGrant,
  linearPublicFields,
  readLinearConnector,
} from "./linear-store.js";
import {
  deferLinearWebhookCleanup,
  hasLinearWebhookObligation,
  linearCleanupNeedsAuthorization,
} from "./linear-webhook-recovery.js";
import { removeLinearWebhook } from "./linear-webhooks.js";
import type { SelfHostedConnectorOptions } from "./self-hosted-connectors-schema.js";
export function linearSnapshot(id?: string): string {
  return JSON.stringify({
    row: readDeviceRows().find((row) => row.connectionId === id),
    secrets: id ? readDeviceSecrets()[id] : undefined,
  });
}
/** Cleanup may change authorization markers, but it cannot adopt another editor's configuration. */
function linearEditSnapshot(id: string, method: string): string {
  const row = readDeviceRows().find((entry) => entry.connectionId === id);
  const mutable = new Set([
    "linear_authorization",
    "linear_verified",
    "linear_granted_scopes",
    "linear_account",
    "linear_expires_at",
    "linear_refreshable",
  ]);
  return JSON.stringify({
    row: row
      ? {
          ...row,
          updatedAt: "",
          fields: Object.fromEntries(
            Object.entries(row.fields).filter(([name]) => !mutable.has(name)),
          ),
        }
      : null,
    pending: readDeviceSecrets()[id]?.linear_pending,
    key: method === "api-key" ? linearGrant(id, "app")?.accessToken : null,
  });
}
export function normalizedLinearState(state: DraftState): DraftState {
  return {
    ...state,
    key: "",
    mcpClientSecret: "",
    oauth: {
      ...state.oauth,
      clientId: state.oauth.clientId.trim(),
      clientSecret: "",
      serverUrl: "https://linear.app",
      authorizationEndpoint: "https://linear.app/oauth/authorize",
      tokenEndpoint: "https://api.linear.app/oauth/token",
      revocationEndpoint: "https://api.linear.app/oauth/revoke",
      userinfoEndpoint: "",
      tokenAuth: "none",
      pkce: "S256",
      registration: "manual",
      authorizationParams: {},
      refreshTokens: true,
    },
  };
}
export function checkLinearEdit(
  previous: { state: DraftState; options: SelfHostedConnectorOptions } | null,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
): void {
  if (!previous) return;
  if (
    previous.state.method !== state.method ||
    previous.state.oauth.clientId !== state.oauth.clientId.trim()
  )
    throw new Error(
      "Remove the existing connector before changing its authorization method or OAuth application",
    );
  const identity = runtime.app ?? runtime.user;
  if (
    identity &&
    previous.options.workspace.trim() !== options.workspace.trim()
  )
    checkLinearWorkspace(options.workspace, {
      id: identity.workspaceId,
      name: identity.workspaceName,
      urlKey: identity.workspaceKey,
    });
}
export async function verifyLinearKey(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
  id?: string,
): Promise<string> {
  if (state.method !== "api-key") return "";
  const key =
    state.key.trim() || (id ? (linearGrant(id, "app")?.accessToken ?? "") : "");
  const identity = await verifyLinearAccount({ kind: "api-key", token: key });
  checkLinearWorkspace(options.workspace, identity.organization);
  runtime.app = {
    kind: "api-key",
    accountLabel: identity.viewer.name,
    workspaceId: identity.organization.id,
    workspaceName: identity.organization.name,
    workspaceKey: identity.organization.urlKey,
    grantedScopes: [],
    expiresAt: null,
  };
  runtime.user = null;
  return key;
}
function webhookChanged(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
  id: string,
): boolean {
  const webhook = runtime.webhook;
  const keyChanged =
    state.method === "api-key" &&
    !!state.key.trim() &&
    state.key.trim() !== linearGrant(id, "app")?.accessToken;
  if (!webhook) {
    const previous = linearConfiguration(id);
    return (
      !!readDeviceSecrets()[id]?.linear_webhook_intent &&
      (keyChanged ||
        linearFingerprint(previous.state, previous.options) !==
          linearFingerprint(state, options))
    );
  }
  return (
    keyChanged ||
    !options.webhookEnabled ||
    webhook.url !== options.webhookUrl?.trim() ||
    JSON.stringify(webhook.resourceTypes) !==
      JSON.stringify(options.webhookResourceTypes)
  );
}
async function prepareLinearWebhookEdit(
  id: string,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
  appChanged: boolean,
  assertUnchanged: () => void,
): Promise<void> {
  if (appChanged && hasLinearWebhookObligation(id)) {
    await deferLinearWebhookCleanup(id, true);
    assertUnchanged();
  } else if (webhookChanged(state, options, runtime, id)) {
    const oldWorkspace = readLinearConnector(id)?.app?.workspaceId;
    const replacement =
      state.method === "api-key" &&
      state.key.trim() &&
      oldWorkspace === runtime.app?.workspaceId
        ? { kind: "api-key" as const, token: state.key.trim() }
        : undefined;
    try {
      await removeLinearWebhook(id, assertUnchanged, replacement);
    } catch (error) {
      if (
        state.method !== "oauth" ||
        !(error instanceof Error) ||
        !linearCleanupNeedsAuthorization(id, error)
      )
        throw error;
      await deferLinearWebhookCleanup(id);
    }
    assertUnchanged();
  }
}
export async function prepareLinearEdit(
  id: string,
  previous: { state: DraftState; options: SelfHostedConnectorOptions },
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
): Promise<string> {
  const expected = linearEditSnapshot(id, state.method);
  const assertUnchanged = () => {
    if (linearEditSnapshot(id, state.method) !== expected)
      throw new Error(
        "Linear configuration changed in another tab; reload before saving",
      );
  };
  const changed =
    state.method === "oauth"
      ? (["app", "user"] as const).filter((actor) => {
          const field = actor === "app" ? "appScopes" : "userScopes";
          return (
            JSON.stringify([...previous.options[field]].sort()) !==
            JSON.stringify([...options[field]].sort())
          );
        })
      : [];
  await prepareLinearWebhookEdit(
    id,
    state,
    options,
    runtime,
    changed.includes("app"),
    assertUnchanged,
  );
  for (const actor of changed) {
    await removeLinearActor(id, actor, assertUnchanged);
    assertUnchanged();
    runtime[actor] = null;
  }
  assertUnchanged();
  // Provider cleanup can refresh a grant; keep the committed surviving identity.
  const latest = readLinearConnector(id);
  if (!latest) throw new Error("Saved Linear connector not found");
  if (state.method === "oauth") {
    runtime.app = latest.app;
    runtime.user = latest.user;
  }
  runtime.webhook = latest.webhook;
  runtime.recovery = latest.recovery;
  return linearSnapshot(id);
}
export function linearSaveInput(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  runtime: LinearRuntime,
  key: string,
  expected: string,
  id?: string,
) {
  if (id && linearSnapshot(id) !== expected)
    throw new Error(
      "Linear configuration changed in another tab; reload before saving",
    );
  const secrets = id ? { ...readDeviceSecrets()[id] } : {};
  const kept = [
    "linear_app_grant",
    "linear_user_grant",
    "linear_webhook_secret",
    "linear_webhook_intent",
    "linear_cleanup_app",
    "linear_cleanup_user",
  ];
  for (const name of Object.keys(secrets))
    if (!kept.includes(name)) Reflect.deleteProperty(secrets, name);
  if (state.method === "api-key")
    secrets.linear_app_grant = JSON.stringify({
      kind: "api-key",
      accessToken: key,
      expiresAt: null,
      scopes: [],
    });
  return {
    providerId: "linear",
    displayName: state.name.trim(),
    scopes: [...new Set([...options.appScopes, ...options.userScopes])],
    fields: {
      self_hosted_configuration: JSON.stringify({
        state: normalizedLinearState(state),
        options,
      }),
      ...linearPublicFields(
        runtime,
        options,
        state.method,
        !!(secrets.linear_cleanup_app || secrets.linear_cleanup_user),
      ),
    },
    secrets,
  };
}
