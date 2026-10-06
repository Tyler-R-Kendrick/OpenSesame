import type { JsonObject } from "@opensesame/os-domain";
import { page } from "../ports.js";
import {
  noteConnectionCreated,
  noteConnectionRevoked,
} from "./activity-log.js";
import { awaitConnectionConsent } from "./connection-consent.js";
import { ConnectionsError } from "./connections-error.js";
import {
  type Integration,
  integrationFromLocal,
} from "./connections-integrations.js";
import {
  mergeLocalGitConnections,
  revokeLocalGitConnection,
} from "./connections-local-git.js";
import type { Connection } from "./connections-types.js";
import { catalogProvider } from "./connector-catalog.js";
import {
  assertNotDecoySession,
  isRealAuthorityBlocked,
  withRealAuthority,
} from "./decoy-session.js";
import {
  createDeviceConnection,
  deviceConnection,
  mergeOfflineConnections,
  revokeDeviceConnection,
  sealDeviceConfiguration,
  sealDeviceCredential,
} from "./device-connectors.js";
import { performSavedCategory } from "./feature-request-send.js";
import { isGitBackupProvider } from "./git-backup-forges.js";
import {
  buildGithubAppRegistration,
  readLocalGithubApp,
} from "./github-app-manifest.js";
import { claimGuestConnection } from "./guest-connections.js";
import { isGuestSession } from "./guest-isolation.js";
import * as vercelConnect from "./vercel-connect-ops.js";

export type { Integration } from "./connections-integrations.js";
export { ConnectionsError };

export type {
  ProviderCategory,
  AuthKind,
  ConfigurationField,
  ScopeDef,
  Egress,
  Provider,
  ConnectionStatus,
  BindingTargetKind,
  Binding,
  Connection,
} from "./connections-types.js";

/** A call no road on this device can take: said with its reason, not tried. */
function noRoad(providerName: string, what: string): ConnectionsError {
  return new ConnectionsError(
    0,
    "unavailable",
    `${providerName} cannot ${what} from this device.`,
  );
}

function providerName(providerId: string): string {
  return catalogProvider(providerId)?.displayName ?? providerId;
}

/* --------------------------------------------------------------- requests */

export type GithubAppRegistration = {
  action: string;
  state: string;
  manifest: JsonObject;
  redirectUrl: string;
};

/** The GitHub App registered from this browser, when there is one. */
function listIntegrationsDefault(): Promise<Integration[]> {
  const local = readLocalGithubApp();
  return Promise.resolve(local ? [integrationFromLocal(local)] : []);
}

function startGithubAppRegistrationDefault(body: {
  returnTo: string;
  displayName?: string;
}): Promise<GithubAppRegistration> {
  return Promise.resolve(buildGithubAppRegistration(body));
}

/** Browser POST to github.com/settings/apps/new (Manifest flow). */
function submitGithubAppManifestDefault(
  registration: GithubAppRegistration,
): void {
  if (!registration.action.startsWith("https://github.com/")) {
    throw new ConnectionsError(
      0,
      "invalid_host",
      "GitHub App registration URL is not github.com — refusing to submit.",
    );
  }
  page().submitForm(
    `${registration.action}?state=${encodeURIComponent(registration.state)}`,
    { manifest: JSON.stringify(registration.manifest) },
    "_self",
  );
}

/** Connect's connectors when it is held, then this device's own. */
function listConnectionsDefault(): Promise<Connection[]> {
  if (vercelConnect.usesConnect()) {
    return vercelConnect.listVercelConnections().then(mergeOfflineConnections);
  }
  return Promise.resolve(mergeOfflineConnections([]));
}

export function getConnection(id: string): Promise<Connection> {
  assertNotDecoySession();
  const local =
    deviceConnection(id) ??
    mergeLocalGitConnections([]).find((row) => row.connectionId === id);
  if (local) return Promise.resolve(local);
  if (vercelConnect.isConnectConnector(id))
    return vercelConnect.getVercelConnection(id);
  return Promise.reject(
    new ConnectionsError(404, "not_found", "That connection is not here."),
  );
}

/**
 * Connect makes a connector it holds. A key or a configuration is a device
 * connector. Anything else — an authorize-only provider Connect does not hold,
 * a git remote (it is saved from its own form) — has no road to be made on.
 */
function createConnectionDefault(body: {
  providerId: string;
  displayName?: string;
  scopes?: string[];
  projectId?: string;
  integrationId?: string;
}): Promise<Connection> {
  if (vercelConnect.usesConnect(body.providerId))
    return vercelConnect.createVercelConnection(body);
  const kind = catalogProvider(body.providerId)?.authKind;
  if (
    !isGitBackupProvider(body.providerId) &&
    (kind === "api_key" || kind === "configuration")
  )
    return Promise.resolve(createDeviceConnection(body));
  return Promise.reject(noRoad(providerName(body.providerId), "be connected"));
}

function authorizeConnectionDefault(
  id: string,
  scopes?: string[],
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  if (vercelConnect.isConnectConnector(id))
    return vercelConnect.authorizeVercelConnection(id, scopes);
  return Promise.reject(noRoad("This connection", "be authorized"));
}

function setConnectionCredentialDefault(
  id: string,
  value: string,
): Promise<Connection> {
  const sealed = sealDeviceCredential(id, value);
  return sealed
    ? Promise.resolve(sealed)
    : Promise.reject(noRoad("This connection", "hold a key"));
}

function setConnectionConfigurationDefault(
  id: string,
  configurationSet: Record<string, string>,
  _configurationClear: string[] = [],
): Promise<Connection> {
  const sealed = sealDeviceConfiguration(id, configurationSet);
  return sealed
    ? Promise.resolve(sealed)
    : Promise.reject(noRoad("This connection", "hold a configuration"));
}

async function revokeConnectionDefault(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
}> {
  const device = revokeDeviceConnection(id);
  if (device) return device;
  const local = await revokeLocalGitConnection(id);
  if (local) return local;
  if (vercelConnect.isConnectConnector(id))
    return vercelConnect.revokeVercelConnection(id);
  throw new ConnectionsError(404, "not_found", "That connection is not here.");
}

/* ----------------------------------------------------------- consent flow */

export type ConsentOutcome =
  | { result: "active"; connection: Connection }
  | { result: "failed"; connection: Connection }
  | { result: "abandoned" };

function awaitConsentDefault(
  connectionId: string,
  popup: Window | null,
  signal?: AbortSignal,
): Promise<ConsentOutcome> {
  return awaitConnectionConsent(connectionId, popup, getConnection, signal);
}

function openConsentPopupDefault(url: string): Window | null {
  return page().open(
    url,
    "opensesame-connect",
    "width=680,height=820,noopener=no,noreferrer=no",
  );
}
export const connectionSeams = {
  setConnectionConfiguration: setConnectionConfigurationDefault,
  revokeConnection: revokeConnectionDefault,

  listIntegrations: listIntegrationsDefault,
  startGithubAppRegistration: startGithubAppRegistrationDefault,
  submitGithubAppManifest: submitGithubAppManifestDefault,
  listConnections: listConnectionsDefault,
  createConnection: createConnectionDefault,
  authorizeConnection: authorizeConnectionDefault,
  setConnectionCredential: setConnectionCredentialDefault,
  awaitConsent: awaitConsentDefault,
  openConsentPopup: openConsentPopupDefault,
};

export function listIntegrations(): Promise<Integration[]> {
  if (isRealAuthorityBlocked()) return Promise.resolve([]);
  return withRealAuthority(() => connectionSeams.listIntegrations());
}
export function startGithubAppRegistration(
  body: Parameters<typeof startGithubAppRegistrationDefault>[0],
): Promise<GithubAppRegistration> {
  return withRealAuthority(() =>
    connectionSeams.startGithubAppRegistration(body),
  );
}
export function submitGithubAppManifest(
  ...args: Parameters<typeof submitGithubAppManifestDefault>
): ReturnType<typeof submitGithubAppManifestDefault> {
  assertNotDecoySession();
  return connectionSeams.submitGithubAppManifest(...args);
}
export function listConnections(): Promise<Connection[]> {
  if (isRealAuthorityBlocked()) return Promise.resolve([]);
  performSavedCategory(["password_managers", "local_storage"]);
  return withRealAuthority(() => connectionSeams.listConnections());
}
export async function createConnection(
  body: Parameters<typeof createConnectionDefault>[0],
): Promise<Connection> {
  const authorityGeneration = assertNotDecoySession();
  const created = await connectionSeams.createConnection(body);
  assertNotDecoySession(authorityGeneration);
  if (isGuestSession()) claimGuestConnection(created.connectionId);
  noteConnectionCreated(created.connectionId);
  return created;
}
export function authorizeConnection(
  ...args: Parameters<typeof authorizeConnectionDefault>
): ReturnType<typeof authorizeConnectionDefault> {
  return withRealAuthority(() => connectionSeams.authorizeConnection(...args));
}
export function setConnectionCredential(
  ...args: Parameters<typeof setConnectionCredentialDefault>
): ReturnType<typeof setConnectionCredentialDefault> {
  return withRealAuthority(() =>
    connectionSeams.setConnectionCredential(...args),
  );
}
export async function awaitConsent(
  ...args: Parameters<typeof awaitConsentDefault>
): ReturnType<typeof awaitConsentDefault> {
  return withRealAuthority(() => connectionSeams.awaitConsent(...args));
}
export function openConsentPopup(url: string): Window | null {
  assertNotDecoySession();
  return connectionSeams.openConsentPopup(url);
}
export function setConnectionConfiguration(
  ...args: Parameters<typeof setConnectionConfigurationDefault>
): ReturnType<typeof setConnectionConfigurationDefault> {
  return withRealAuthority(() =>
    connectionSeams.setConnectionConfiguration(...args),
  );
}
export function revokeConnection(
  id: string,
): ReturnType<typeof revokeConnectionDefault> {
  assertNotDecoySession();
  const result = connectionSeams.revokeConnection(id);
  noteConnectionRevoked(id);
  return result;
}
