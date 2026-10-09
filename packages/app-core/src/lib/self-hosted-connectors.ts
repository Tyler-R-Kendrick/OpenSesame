/** Provider configuration saved on this device, without a hosted Connect service. */
import type { DraftState } from "./connect-draft.js";
import type { ConnectPlan } from "./connect-plan.js";
import type { Connection } from "./connections.js";
import {
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConfigurationDurable,
} from "./device-connector-records.js";
import {
  type DeviceConnectorConfiguration,
  saveDeviceConnectorConfigurationDurable,
} from "./device-connectors.js";
import { selfHostedConfig } from "./self-hosted-config.js";
import {
  DraftSchema,
  OptionsSchema,
  SavedSchema,
  type SelfHostedConnectorOptions,
} from "./self-hosted-connectors-schema.js";

export type { SelfHostedConnectorOptions };

const FIELD = "self_hosted_configuration";

export function isSelfHostedConnector(connection: Connection | null): boolean {
  return (
    !!connection &&
    readDeviceRows().some(
      (row) =>
        row.connectionId === connection.connectionId &&
        row.fields[FIELD] !== undefined,
    )
  );
}

function sanitizedState(state: DraftState): DraftState {
  return {
    ...state,
    key: "",
    mcpClientSecret: "",
    oauth: { ...state.oauth, clientSecret: "" },
  };
}

/** Read editable configuration, revealing only whether a compatible secret exists. */
export function readSelfHostedConnector(connectionId: string): {
  state: DraftState;
  options: SelfHostedConnectorOptions;
  hasCredential: boolean;
} | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  const raw = row?.fields[FIELD];
  if (!raw) return null;
  try {
    const parsed = SavedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const state = sanitizedState(parsed.data.state);
    const key = secretKey(state);
    return {
      state,
      options: parsed.data.options,
      hasCredential: key !== null && !!readDeviceSecrets()[connectionId]?.[key],
    };
  } catch {
    return null;
  }
}

function secretKey(state: DraftState): string | null {
  switch (state.method) {
    case "oauth":
      return state.oauth.tokenAuth === "none" ? null : "oauth_client_secret";
    case "api-key":
      return "api_key";
    case "mcp":
      return state.mcpRegistration === "manual" ? "mcp_client_secret" : null;
    case "managed":
      return null;
  }
}

function secretValue(state: DraftState): string {
  if (state.method === "oauth") return state.oauth.clientSecret;
  if (state.method === "api-key") return state.key;
  if (state.method === "mcp") return state.mcpClientSecret;
  return "";
}

function sameCredentialTarget(
  previous: DraftState,
  state: DraftState,
): boolean {
  if (previous.method !== state.method) return false;
  if (state.method === "oauth") {
    return (
      ["clientId", "serverUrl", "tokenEndpoint", "registration"] as const
    ).every((field) => previous.oauth[field] === state.oauth[field]);
  }
  if (state.method === "mcp") {
    return (
      previous.mcpClientId === state.mcpClientId &&
      previous.mcpRegistration === state.mcpRegistration
    );
  }
  return true;
}

function compatibleSecret(state: DraftState, existingId?: string): string {
  if (!existingId) return "";
  const previous = readSelfHostedConnector(existingId);
  if (!previous || !sameCredentialTarget(previous.state, state)) return "";
  const key = secretKey(state);
  return key ? (readDeviceSecrets()[existingId]?.[key] ?? "") : "";
}

/** Whether the saved credential belongs to the application currently being edited. */
export function hasSavedSelfHostedCredential(
  state: DraftState,
  existingId?: string,
): boolean {
  return !!compatibleSecret(state, existingId);
}

function https(value: string): boolean {
  if (/[{}]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function metadataProblems(
  plan: ConnectPlan,
  options: SelfHostedConnectorOptions,
): string[] {
  const problems: string[] = [];
  const config = selfHostedConfig(plan);
  const requiredWorkspace = config?.fields.some(
    (field) => field.name === "workspace" && field.required,
  );
  if (requiredWorkspace && !options.workspace.trim()) {
    problems.push("Enter your provider workspace");
  }
  const labels = {
    appScopes: "app scopes",
    userScopes: "user scopes",
    webhookResourceTypes: "webhook resource types",
  } as const;
  for (const field of [
    "appScopes",
    "userScopes",
    "webhookResourceTypes",
  ] as const) {
    const known = new Set(config?.[field].map((choice) => choice.name) ?? []);
    if (options[field].some((name) => !known.has(name))) {
      problems.push(`Select supported ${labels[field]} for this provider`);
    }
  }
  return problems;
}

function selectionProblems(
  plan: ConnectPlan,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  existingId?: string,
): string[] {
  const problems: string[] = [];
  if (plan.refused) problems.push("This provider cannot be connected");
  if (!state.name.trim()) problems.push("Enter a connector name");
  if (
    state.method === "managed" ||
    !plan.methods.some((method) => method.kind === state.method)
  ) {
    problems.push("Select a supported OAuth, MCP, or API key method");
  }
  if (options.mode === "managed" && state.method !== "oauth") {
    problems.push(
      "Managed configuration requires your own provider OAuth application",
    );
  }
  if (existingId) {
    const row = readDeviceRows().find(
      (entry) => entry.connectionId === existingId,
    );
    if (
      !row ||
      row.providerId !== plan.id ||
      !readSelfHostedConnector(existingId)
    ) {
      problems.push("Saved connector not found for this provider");
    }
  }
  return problems;
}

function oauthProblems(state: DraftState, credential: string): string[] {
  const problems: string[] = [];
  const oauth = state.oauth;
  if (
    [oauth.serverUrl, oauth.authorizationEndpoint, oauth.tokenEndpoint].some(
      (url) => !https(url),
    )
  ) {
    problems.push(
      "Enter complete HTTPS OAuth server, authorization, and token URLs",
    );
  }
  for (const value of [oauth.revocationEndpoint, oauth.userinfoEndpoint]) {
    if (value && !https(value))
      problems.push("Optional OAuth endpoints must use HTTPS");
  }
  if (oauth.registration === "manual") {
    if (!oauth.clientId.trim())
      problems.push("Enter your provider OAuth client ID");
    if (oauth.tokenAuth !== "none" && !credential.trim()) {
      problems.push("Enter your provider OAuth client secret");
    }
  }
  return problems;
}

function credentialProblems(
  plan: ConnectPlan,
  state: DraftState,
  credential: string,
): string[] {
  if (state.method === "oauth") return oauthProblems(state, credential);
  const problems: string[] = [];
  if (state.method === "api-key") {
    if (!credential.trim()) problems.push("Enter your provider API key");
    if (
      state.serviceUrls.length === 0 ||
      state.serviceUrls.some((url) => !https(url))
    ) {
      problems.push("Enter at least one HTTPS service URL");
    }
  }
  if (state.method === "mcp") {
    const method = plan.methods.find((item) => item.kind === "mcp");
    const manual =
      method?.kind === "mcp" &&
      method.mcp.status === "ok" &&
      method.mcp.registration === "manual";
    if (manual && !state.mcpClientId.trim())
      problems.push("Enter your MCP OAuth client ID");
  }
  return problems;
}

/** Saving configuration does not authorize a provider account or grant scopes. */
export function selfHostedConnectorProblems(
  plan: ConnectPlan,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  existingId?: string,
): string[] {
  if (!DraftSchema.safeParse(state).success)
    return ["Invalid connector configuration"];
  if (!OptionsSchema.safeParse(options).success)
    return ["Invalid connector options or icon"];
  const credential = secretValue(state) || compatibleSecret(state, existingId);
  return [
    ...metadataProblems(plan, options),
    ...selectionProblems(plan, state, options, existingId),
    ...credentialProblems(plan, state, credential),
  ];
}

function requestedScopes(
  state: DraftState,
  options: SelfHostedConnectorOptions,
): string[] {
  if (state.method !== "oauth") return [];
  return [
    ...new Set([
      ...state.oauth.scopes,
      ...options.appScopes,
      ...options.userScopes,
    ]),
  ];
}

function configurationInput(
  plan: ConnectPlan,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  existingId?: string,
): DeviceConnectorConfiguration {
  const problems = selfHostedConnectorProblems(
    plan,
    state,
    options,
    existingId,
  );
  if (problems.length > 0) throw new Error(problems.join(". "));
  const key = secretKey(state);
  const value = secretValue(state) || compatibleSecret(state, existingId);
  return {
    providerId: plan.id,
    displayName: state.name.trim(),
    scopes: requestedScopes(state, options),
    fields: {
      [FIELD]: JSON.stringify({
        state: sanitizedState(DraftSchema.parse(state)),
        options: OptionsSchema.parse(options),
      }),
    },
    secrets: key && value ? { [key]: value } : {},
  };
}

/** Upsert one local configuration; blank secrets on an unchanged edit keep the sealed value. */
export async function saveSelfHostedConnector(
  plan: ConnectPlan,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  existingId?: string,
): Promise<Connection> {
  return saveSelfHostedConnectorDurable(plan, state, options, existingId);
}

/** Wait for encrypted persistence before clearing the caller's credential draft. */
export async function saveSelfHostedConnectorDurable(
  plan: ConnectPlan,
  state: DraftState,
  options: SelfHostedConnectorOptions,
  existingId?: string,
): Promise<Connection> {
  return saveDeviceConnectorConfigurationDurable(
    () => configurationInput(plan, state, options, existingId),
    existingId,
  );
}

/** Remove the committed configuration before reporting completion to the caller. */
export async function revokeSelfHostedConnectorDurable(
  connectionId: string,
): Promise<void> {
  if (!(await removeDeviceConfigurationDurable(connectionId))) {
    throw new Error("Saved connector not found on this device");
  }
}
