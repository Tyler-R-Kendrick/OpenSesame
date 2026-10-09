/**
 * The connections this device holds, and the roads that make them.
 *
 * A connection is one of three things, and every one is made and kept by the
 * browser itself (ADR 0128: Pages does not speak Host; ADR 0151: a connector
 * page acts on the roads a device has):
 *
 * - a **Connect** connector, once Vercel Connect holds its credential;
 * - a **device** connector — a key or a configuration sealed on this device
 *   (`device-connectors.ts`);
 * - a **local git remote** (`connections-local-git.ts`).
 *
 * Nothing here sends a request to a Host. A call no road can take is refused
 * with the reason, never attempted.
 */

import {
  type JsonObject,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import { page, pageOrigin } from "../ports.js";
import {
  noteConnectionCreated,
  noteConnectionRevoked,
} from "./activity-log.js";
import { ConnectionsError } from "./connections-error.js";
import {
  type Integration,
  integrationFromLocal,
} from "./connections-integrations.js";
import {
  mergeLocalGitConnections,
  revokeLocalGitConnection,
} from "./connections-local-git.js";
import { catalogProvider } from "./connector-catalog.js";
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

export type ProviderCategory =
  | "identity"
  | "backup_recovery"
  | "encryption"
  | "password_managers"
  | "agent_harnesses"
  | "networking"
  | "wallet"
  | "cloud_secret_storage"
  | "local_storage"
  | "developer"
  | "productivity"
  | "communication"
  | "storage"
  | "crm"
  | "testing"
  | "certificates"
  | "custom";
export type AuthKind =
  | "oauth2_authorization_code"
  | "api_key"
  | "configuration";

export type ConfigurationField = {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
};

export type ScopeDef = {
  name: string;
  description: string;
  sensitive: boolean;
  default: boolean;
};

export type Egress = {
  scheme: string;
  authorities: string[];
  pathPrefixes: string[];
};

export type Provider = {
  id: string;
  displayName: string;
  category: ProviderCategory;
  docsUrl: string;
  authKind: AuthKind;
  supportsRefresh: boolean;
  /** Deployment has a client id and secret for this provider. */
  configured: boolean;
  /** Host can supply every connection field without asking the user. */
  autoConfigurable: boolean;
  /** Exact environment variables the deployment is missing. Empty when configured. */
  missingConfig: string[];
  /** Host OAuth callback URL for this provider, when applicable. */
  callbackUrl: string | null;
  scopes: ScopeDef[];
  egress: Egress;
  operations: string[];
  configurationFields?: ConfigurationField[];
};

export type ConnectionStatus =
  | "pending"
  | "active"
  | "needs_reauth"
  | "expired"
  | "revoked"
  | "error";

export type BindingTargetKind =
  | "organization"
  | "project"
  | "agent"
  | "group"
  | "device"
  | "identity";

export type Binding = {
  id: string;
  targetKind: BindingTargetKind;
  targetId: string;
  targetLabel: string | null;
  createdAt: string;
};

export type Connection = {
  connectionId: string;
  connectionRef: string;
  logicalName: string;
  displayName: string;
  providerId: string;
  /** Tenant integration that sealed this connection's OAuth/App credentials. */
  integrationId: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  organizationId: string;
  projectId: string | null;
  ownerKind: string;
  shareability: "private" | "delegable" | "organization_wide";
  requestedScopes: string[];
  grantedScopes: string[];
  accountLabel: string | null;
  expiresAt: string | null;
  refreshable: boolean;
  lastRefreshedAt: string | null;
  maxInvokeLevel: number;
  egress: Egress;
  bindings: Binding[];
  createdAt: string;
  updatedAt: string;
};

function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
}

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
  const device = await revokeDeviceConnection(id);
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

const POLL_MS = 1500;
const CONSENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Wait for the consent popup's round trip. Connect bounces the popup back to
 * this app, which tells its opener from its own origin, so that is the one
 * origin a message may come from; the poll settles it when no message does.
 */
async function awaitConsentDefault(
  connectionId: string,
  popup: Window | null,
  signal?: AbortSignal,
): Promise<ConsentOutcome> {
  const origin = pageOrigin();
  const deadline = Date.now() + CONSENT_TIMEOUT_MS;

  let settled = false;
  let sawMessage = false;
  let onMessage: ((event: MessageEvent) => void) | null = null;

  const messaged = new Promise<void>((resolve) => {
    onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = obj(event.data);
      if (data.type !== "opensesame:connection") return;
      if (data.connectionId !== connectionId) return;
      sawMessage = true;
      resolve();
    };
    page().addEventListener("message", onMessage);
  });

  try {
    while (!settled) {
      if (signal?.aborted) return { result: "abandoned" };
      if (Date.now() > deadline) return { result: "abandoned" };

      if (sawMessage) {
        await sleep(POLL_MS);
      } else {
        await Promise.race([messaged, sleep(POLL_MS)]);
      }

      const connection = await getConnection(connectionId).catch(() => null);
      if (connection && connection.status !== "pending") {
        settled = true;
        return connection.status === "active"
          ? { result: "active", connection }
          : { result: "failed", connection };
      }

      if (popup?.closed) {
        await sleep(POLL_MS);
        const last = await getConnection(connectionId).catch(() => null);
        if (last && last.status !== "pending") {
          return last.status === "active"
            ? { result: "active", connection: last }
            : { result: "failed", connection: last };
        }
        return { result: "abandoned" };
      }
    }
    return { result: "abandoned" };
  } finally {
    if (onMessage) page().removeEventListener("message", onMessage);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return connectionSeams.listIntegrations();
}
export function startGithubAppRegistration(
  body: Parameters<typeof startGithubAppRegistrationDefault>[0],
): Promise<GithubAppRegistration> {
  return connectionSeams.startGithubAppRegistration(body);
}
export function submitGithubAppManifest(
  ...args: Parameters<typeof submitGithubAppManifestDefault>
): ReturnType<typeof submitGithubAppManifestDefault> {
  return connectionSeams.submitGithubAppManifest(...args);
}
export function listConnections(): Promise<Connection[]> {
  performSavedCategory(["password_managers", "local_storage"]);
  return connectionSeams.listConnections();
}
export async function createConnection(
  body: Parameters<typeof createConnectionDefault>[0],
): Promise<Connection> {
  const created = await connectionSeams.createConnection(body);
  if (isGuestSession()) claimGuestConnection(created.connectionId);
  noteConnectionCreated(created.connectionId);
  return created;
}
export function authorizeConnection(
  ...args: Parameters<typeof authorizeConnectionDefault>
): ReturnType<typeof authorizeConnectionDefault> {
  return connectionSeams.authorizeConnection(...args);
}
export function setConnectionCredential(
  ...args: Parameters<typeof setConnectionCredentialDefault>
): ReturnType<typeof setConnectionCredentialDefault> {
  return connectionSeams.setConnectionCredential(...args);
}
export async function awaitConsent(
  ...args: Parameters<typeof awaitConsentDefault>
): ReturnType<typeof awaitConsentDefault> {
  return connectionSeams.awaitConsent(...args);
}
export function openConsentPopup(url: string): Window | null {
  return connectionSeams.openConsentPopup(url);
}
export function setConnectionConfiguration(
  ...args: Parameters<typeof setConnectionConfigurationDefault>
): ReturnType<typeof setConnectionConfigurationDefault> {
  return connectionSeams.setConnectionConfiguration(...args);
}
export function revokeConnection(
  id: string,
): ReturnType<typeof revokeConnectionDefault> {
  const result = connectionSeams.revokeConnection(id);
  noteConnectionRevoked(id);
  return result;
}
