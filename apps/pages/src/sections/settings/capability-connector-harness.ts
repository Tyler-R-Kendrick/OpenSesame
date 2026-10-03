import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { connectorActs } from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  createConnection,
  setConnectionConfiguration,
  setConnectionCredential,
} from "@opensesame/app-core/lib/connections.js";
import { configurationPayload } from "@opensesame/app-core/lib/connector-guidance.js";
import { saveForgeConnector } from "@opensesame/app-core/lib/device-connectors.js";
import type { GitRemoteConfiguration } from "@opensesame/app-core/lib/git-auth-modes.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { providerTileItems } from "./provider-tile-items.js";

/**
 * The listed connectors a person can save on this device: a key, a
 * configuration or a remote. An authorize-only provider has no saved
 * operation — Connect or its own App takes it — and `createConnection`
 * refuses it (`connections.test.ts`).
 */
export function listedProviders(): Provider[] {
  const tile = (provider: Provider) =>
    connectorActs(provider, false) ? ("page" as const) : null;
  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const feature of FEATURES) {
    for (const category of feature.providerCategories) {
      for (const item of providerTileItems(category, tile)) {
        if (seen.has(item.provider.id)) continue;
        if (item.provider.authKind === "oauth2_authorization_code") continue;
        seen.add(item.provider.id);
        providers.push(item.provider);
      }
    }
  }
  return providers;
}

export function displayName(provider: Provider): string {
  return `pub-${provider.id}-name`;
}

function fieldValue(provider: Provider, name: string, secret: boolean): string {
  if (name === "remote_url")
    return `https://git.example/${provider.id}/repo.git`;
  if (name === "auth_mode") return "https_token";
  if (name === "domain") return `${provider.id}.example`;
  return `${secret ? "sek" : "pub"}-${provider.id}-${name}`;
}

const GIT_SECRET_KEYS = new Set([
  "token",
  "password",
  "ssh_private_key",
  "ssh_passphrase",
]);

function catalogValues(provider: Provider) {
  const values: Record<string, string> = {};
  for (const field of provider.configurationFields ?? []) {
    values[field.name] = fieldValue(provider, field.name, field.secret);
  }
  if (isGitBackupProvider(provider.id)) {
    values.remote_url ??= `https://git.example/${provider.id}/repo.git`;
    values.auth_mode ??= "https_token";
    values.token ??= `sek-${provider.id}-token`;
  }
  return values;
}

function secretNames(provider: Provider): Set<string> {
  const names = new Set(
    (provider.configurationFields ?? [])
      .filter((field) => field.secret)
      .map((field) => field.name),
  );
  if (isGitBackupProvider(provider.id)) {
    for (const key of GIT_SECRET_KEYS) names.add(key);
  }
  return names;
}

function publicFrom(
  provider: Provider,
  values: Record<string, string>,
): Record<string, string> {
  const hidden = secretNames(provider);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => !hidden.has(name) && value.trim() !== "",
    ),
  );
}

export function selectedScopes(provider: Provider): string[] {
  if (provider.authKind === "oauth2_authorization_code") {
    return provider.scopes.map((scope) => scope.name);
  }
  return provider.scopes
    .filter((scope) => scope.default)
    .map((scope) => scope.name);
}

function gitConfiguration(
  values: Record<string, string>,
): GitRemoteConfiguration {
  const configuration: GitRemoteConfiguration & Record<string, string> = {
    remote_url: values.remote_url ?? "https://git.example/repo.git",
    auth_mode: "https_token",
  };
  for (const [name, value] of Object.entries(values))
    configuration[name] = value;
  configuration.auth_mode = "https_token";
  return configuration;
}

export function expectedSecrets(provider: Provider) {
  const values = catalogValues(provider);
  if (isGitBackupProvider(provider.id))
    return publicSplit(provider, values).secrets;
  const secrets: Record<string, string> = {};
  if (provider.authKind === "api_key")
    secrets.credential = `sek-${provider.id}-credential`;
  const hidden = secretNames(provider);
  for (const [name, value] of Object.entries(
    withoutApiKeyField(provider, values),
  )) {
    if (hidden.has(name) && value.trim() !== "") secrets[name] = value.trim();
  }
  return secrets;
}

function withoutApiKeyField(
  provider: Provider,
  values: Record<string, string>,
): Record<string, string> {
  if (provider.authKind !== "api_key") return values;
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => name !== "api_key"),
  );
}

interface FieldSplit {
  readonly fields: Record<string, string>;
  readonly secrets: Record<string, string>;
}

function publicSplit(
  provider: Provider,
  values: Record<string, string>,
): FieldSplit {
  const fields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value.trim() === "") continue;
    if (secretNames(provider).has(name)) secrets[name] = value;
    else fields[name] = value;
  }
  return { fields, secrets };
}

export function expectedPublic(provider: Provider): Record<string, string> {
  const values = catalogValues(provider);
  if (isGitBackupProvider(provider.id))
    return publicSplit(provider, values).fields;
  const payload = configurationPayload(
    provider,
    withoutApiKeyField(provider, values),
  );
  return publicFrom(provider, payload);
}

export async function saveListed(provider: Provider) {
  const name = displayName(provider);
  if (isGitBackupProvider(provider.id)) {
    return saveForgeConnector(provider, {
      displayName: name,
      configuration: gitConfiguration(catalogValues(provider)),
    });
  }
  const scopes = selectedScopes(provider);
  const connection = await createConnection({
    providerId: provider.id,
    displayName: name,
    scopes: scopes.length > 0 ? scopes : undefined,
  });
  if (provider.authKind === "api_key") {
    await setConnectionCredential(
      connection.connectionId,
      `sek-${provider.id}-credential`,
    );
  }
  const payload = configurationPayload(
    provider,
    withoutApiKeyField(provider, catalogValues(provider)),
  );
  if (
    provider.authKind === "configuration" ||
    Object.keys(payload).length > 0
  ) {
    await setConnectionConfiguration(connection.connectionId, payload);
  }
  return connection;
}
