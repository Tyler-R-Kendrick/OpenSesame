/**
 * Which roads a connector's own page has on this device (ADR 0156, ADR 0128).
 *
 * A connector page is a place to act. What it can act through is one of:
 *
 * - **local** — the browser does it alone: a git remote sealed on the device,
 *   the GitHub App registered from the browser, a key or configuration sealed
 *   in an unlocked vault, the vault-history switch;
 * - **connect** — Vercel Connect, once its credential is held: the page's own
 *   Connect panels seal it, then create and authorize a connector;
 * - **host** — a configured Host with a live, approved browser grant that
 *   carries `host.connections.write` (a join or sync grant does not). Pages
 *   opens no pairing ceremony (ADR 0128), so on the static deployment this is
 *   closed, and every form that can only run through it must not be drawn:
 *   pressing its key could only fail.
 *
 * One definition, so the tiles under Settings › Capabilities, the connector
 * page and the forms on it agree about what is offered. Pure reads of the
 * seamed session state; the React shell subscribes and asks again.
 */

import type { AuthKind, Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { isGitBackupProvider } from "./git-backup-forges.js";
import { HISTORY_BACKUP_GROUPS } from "./history-backups.js";
import { HOST_CONNECTIONS_WRITE, hostGrantAllows } from "./host-grant.js";
import { hostBase, hostLocalSessionEligible } from "./identity.js";

/**
 * Connect's own answers (ADR 0153). Off until `connectors.external` installs
 * them, so a minimal build never loads the Connect catalog.
 */
export const connectRoadSeams = {
  usesConnect: (_providerId?: string): boolean => false,
  hasConnectRoute: (_providerId: string): boolean => false,
};

export function resetConnectRoadSeams(): void {
  connectRoadSeams.usesConnect = () => false;
  connectRoadSeams.hasConnectRoute = () => false;
}

let epoch = 0;
const listeners = new Set<() => void>();

/** Changes when a Connect road opens or closes. */
export function connectRoadEpoch(): number {
  return epoch;
}

export function subscribeConnectRoads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyConnectRoads(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

/**
 * Panels that only seal a public key or a device configuration in the
 * unlocked vault (`AwsKmsConnectPanel`, `GcpKmsConnectPanel`). They draw
 * nothing for a guest or a locked vault, so they are not offered there.
 */
export const VAULT_SEALED_PANELS: readonly string[] = ["aws-kms", "gcp-kms"];

export type FormRoad = "connect" | "host" | "local";

function deviceConfigurable(authKind: AuthKind): boolean {
  return authKind === "api_key" || authKind === "configuration";
}

/**
 * A Host is configured and this browser holds a live approved grant to it that
 * carries `host.connections.write`. A grant that only joins or syncs is live
 * and approved, and still cannot create a connection or write a credential,
 * so it opens none of the connector forms (ADR 0151).
 */
export function hostRoadOpen(): boolean {
  return (
    hostBase() !== "" &&
    hostLocalSessionEligible() &&
    hostGrantAllows(HOST_CONNECTIONS_WRITE)
  );
}

/**
 * The road a provider's key, configuration or authorize form saves through,
 * or null when none is open. A key or a configuration seals on this device
 * when no Host is open, and through the Host when that road is open.
 * Authorizing can also run on Connect.
 */
export function formRoad(
  providerId: string,
  authKind: AuthKind,
): FormRoad | null {
  if (
    authKind === "oauth2_authorization_code" &&
    connectRoadSeams.usesConnect(providerId)
  ) {
    return "connect";
  }
  if (deviceConfigurable(authKind)) return hostRoadOpen() ? "host" : "local";
  return hostRoadOpen() ? "host" : null;
}

/**
 * Does `ConnectForm` have a control to draw for this provider? A git remote is
 * sealed on the device and GitHub's App is registered from the browser, so
 * both always do; every other form saves through a road that must be open.
 */
export function connectFormDraws(
  provider: Pick<Provider, "id" | "authKind">,
): boolean {
  if (isGitBackupProvider(provider.id) || provider.id === "github") return true;
  return formRoad(provider.id, provider.authKind) !== null;
}

/** What the browser does alone for this provider, before any service. */
function actsLocally(providerId: string): boolean {
  return (
    isGitBackupProvider(providerId) ||
    providerId === "github" ||
    HISTORY_BACKUP_GROUPS.some((group) =>
      group.providerIds.includes(providerId),
    )
  );
}

/**
 * Does this connector's page have anything a person can do on this device?
 * A tile whose page has nothing to act on is not drawn (ADR 0156): no row
 * that leads to a page that does not configure the thing.
 */
export function connectorActs(
  provider: Pick<Provider, "id">,
  sealedVault: boolean,
): boolean {
  // These panels draw for an unlocked vault and for nothing else; no service
  // road changes that.
  if (VAULT_SEALED_PANELS.includes(provider.id)) return sealedVault;
  const kind = catalogProvider(provider.id)?.authKind;
  return (
    actsLocally(provider.id) ||
    connectRoadSeams.hasConnectRoute(provider.id) ||
    hostRoadOpen() ||
    (kind !== undefined && deviceConfigurable(kind))
  );
}
