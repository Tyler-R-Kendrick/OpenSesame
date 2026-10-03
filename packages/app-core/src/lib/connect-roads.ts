/**
 * Which roads a connector's own page has on this device (ADR 0158, ADR 0151).
 *
 * A connector page is a place to act. What it can act through is one of two
 * roads, and the browser opens both by itself:
 *
 * - **local** — the browser does it alone: a git remote sealed on the device,
 *   the GitHub App registered from the browser, a key or configuration sealed
 *   on this device (under the at-rest key, ADR 0149), the vault-history
 *   switch;
 * - **connect** — Vercel Connect, once its credential is held: the page's own
 *   Connect panels seal it, then create and authorize a connector.
 *
 * There is no third road. Pages does not speak Host (ADR 0128), so no
 * connector form saves through one, and a form only a Host could take is not
 * drawn: pressing its key could only fail (ADR 0151, amended 2026-10-03).
 *
 * One definition, so the tiles under Settings › Capabilities, the connector
 * page and the forms on it agree about what is offered. Pure reads of the
 * seamed session state; the React shell subscribes and asks again.
 */

import type { AuthKind, Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { isGitBackupProvider } from "./git-backup-forges.js";
import { HISTORY_BACKUP_GROUPS } from "./history-backups.js";

/**
 * Connect's own answers, and whether the connector pages exist (ADR 0153).
 * Off until `connectors.external` installs them, so a minimal build never
 * loads the Connect catalog and has no connector page to link to.
 */
export const connectRoadSeams = {
  usesConnect: (_providerId?: string): boolean => false,
  hasConnectRoute: (_providerId: string): boolean => false,
  /** The connector pages (`/settings/connections/<provider>`) are routed. */
  pagesOpen: (): boolean => false,
};

export function resetConnectRoadSeams(): void {
  connectRoadSeams.usesConnect = () => false;
  connectRoadSeams.hasConnectRoute = () => false;
  connectRoadSeams.pagesOpen = () => false;
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

export type FormRoad = "connect" | "local";

function deviceConfigurable(authKind: AuthKind): boolean {
  return authKind === "api_key" || authKind === "configuration";
}

/**
 * The road a provider's key, configuration or authorize form saves through,
 * or null when none is open. A key or a configuration seals on this device;
 * authorizing runs on Connect, once Connect holds the provider.
 */
export function formRoad(
  providerId: string,
  authKind: AuthKind,
): FormRoad | null {
  if (authKind === "oauth2_authorization_code") {
    return connectRoadSeams.usesConnect(providerId) ? "connect" : null;
  }
  return "local";
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
 * Are the connector pages routed? They are only while Connections is on
 * (ADR 0153), so a link into one — a tile, a row, an add key — is offered
 * only then.
 */
export function connectorPagesOpen(): boolean {
  return connectRoadSeams.pagesOpen();
}

/** A history road has an enable switch of its own (`BackupEnableSwitch`). */
export function hasHistorySwitch(providerId: string): boolean {
  return (HISTORY_BACKUP_GROUPS[0]?.providerIds ?? []).includes(providerId);
}

/**
 * What a connector's tile offers on this device, or null when it offers
 * nothing and is not drawn (ADR 0158):
 *
 * - **page** — a link to the connector's own page. The pages are routed only
 *   while Connections is on (ADR 0153), so this is offered only then, and
 *   only where the page has something to do (`connectorActs`);
 * - **switch** — no page, but the tile's own enable switch acts: a history
 *   road can be turned on or off without the Connections section.
 *
 * A tile that would link to a page nothing routes is never drawn.
 */
export type TileRoad = "page" | "switch";

export function connectorTile(
  provider: Pick<Provider, "id">,
  sealedVault: boolean,
): TileRoad | null {
  if (connectorPagesOpen()) {
    return connectorActs(provider, sealedVault) ? "page" : null;
  }
  return hasHistorySwitch(provider.id) ? "switch" : null;
}

/**
 * Does this connector's page have anything a person can do on this device?
 * A tile whose page has nothing to act on is not drawn (ADR 0158): no row
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
    (kind !== undefined && deviceConfigurable(kind))
  );
}
