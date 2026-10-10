/**
 * The app's safe state predicates.
 *
 * Every one of these answers a question about arrival or availability — did
 * the person reach this area, is that plane up, is the vault open. None of
 * them reads a field, an item, a folder name, an address or anything else a
 * person authored, which is why the whole set can be handed to a model as
 * page context and waited on by a guide.
 *
 * They must also be safe to read at any moment, including while the vault is
 * locked: `readGuidePredicate` is called from a wait loop that has no idea
 * what the app is doing, so a predicate that threw would take the guide with
 * it.
 */

import { describeAccount } from "../../lib/account.js";
import { isRemoteIdentityConfigured } from "../../lib/device-identity.js";
import { currentSession } from "../../lib/identity.js";
import { vaultStore } from "../../lib/vault/store.js";
import { listAvailableUnlockMethods } from "../../lib/vault/unlock-methods.js";
import { isOnline, page } from "../../ports.js";
import {
  type GuideRouteId,
  guideRouteForPath,
  guideRouteWithin,
} from "./routes.js";
import {
  announceGuideStateChange,
  declareGuidePredicate,
  isKnownGuidePredicate,
} from "./state.js";
import type { GuidePredicateDescriptor } from "./state.js";

/**
 * Whether the Connections area is currently showing at least one live
 * connection. The Host's connection list is only ever fetched asynchronously,
 * so the section publishes the coarse answer here rather than a predicate
 * pretending it can read it synchronously. A count, never a name.
 */
let connectionsPresent = false;

export function noteGuideConnectionsPresent(present: boolean): void {
  if (connectionsPresent === present) return;
  connectionsPresent = present;
  announceGuideStateChange();
}

let installOffer: () => boolean = () => false;

/**
 * Where the shell says whether Settings draws an install to make or report.
 * That state lives in Pages (the browser's install signals), so the shell
 * hands the registry its reader instead of the registry importing a screen.
 */
export function provideGuideInstallOffer(read: () => boolean): void {
  installOffer = read;
}

/** How this device draws the shell, as the shell last said it. */
export type GuideDeviceForm = Readonly<{
  /** Below the one-pane breakpoint: a menu key and a More key, no rail. */
  narrow: boolean;
  /** A precise pointer is attached, so Settings draws Keybindings. */
  keys: boolean;
}>;

let deviceForm: () => GuideDeviceForm = () => ({ narrow: false, keys: true });

/**
 * Where the shell says how it is drawn. The width and the pointer live in the
 * browser, so the shell hands the registry its reader instead of the registry
 * asking the window; absent, the page is a desktop with a keyboard.
 */
export function provideGuideDeviceForm(read: () => GuideDeviceForm): void {
  deviceForm = read;
}

/** The plugin panels the active plugin capabilities draw, by plugin id. */
const pluginPanels = new Map<string, () => boolean>();

/**
 * A plugin capability says whether its panel is drawn, which depends on a
 * paired daemon or the means to pair one. Returns what undoes it, so a
 * capability that is no longer in the plan stops answering.
 */
export function provideGuidePluginPanel(
  plugin: string,
  read: () => boolean,
): () => void {
  pluginPanels.set(plugin, read);
  return () => {
    if (pluginPanels.get(plugin) === read) pluginPanels.delete(plugin);
  };
}

function pluginPanelDrawn(plugin: string): boolean {
  return pluginPanels.get(plugin)?.() === true;
}

/**
 * Whether Settings draws the voice and inference picks. The shell says so,
 * because that panel is the on-device model's contribution: the AI section
 * can still be drawn (WebMCP, or the remote support model) while the picks
 * are not. Absent, they are not drawn.
 */
let supportModelPicks: () => boolean = () => false;

export function provideGuideSupportModelPicks(read: () => boolean): void {
  supportModelPicks = read;
}

function currentRoute(): GuideRouteId {
  return guideRouteForPath(page().location.pathname);
}

function onRoute(prefix: GuideRouteId): boolean {
  return guideRouteWithin(currentRoute(), prefix);
}

function vaultUnlocked(): boolean {
  return vaultStore.getSnapshot().status === "unlocked";
}

export const GUIDE_PREDICATES: readonly GuidePredicateDescriptor[] = [
  {
    id: "vault.unlocked",
    description: "The vault is open and its key is held in memory.",
    read: vaultUnlocked,
  },
  {
    id: "vault.empty",
    description:
      "The vault is showing no items at all. True while it is locked, because nothing is decrypted to show.",
    read: () =>
      vaultStore.getSnapshot().items.every((item) => item.deletedAt !== null),
  },
  {
    id: "vault.has-items",
    description:
      "The open vault holds at least one item outside the trash. False while it is locked.",
    read: () =>
      vaultStore.getSnapshot().items.some((item) => item.deletedAt === null),
  },
  {
    id: "vault.has-account",
    description:
      "The open vault holds at least one account outside the trash. The accounts filter and the username and password copy keys exist only then. False while it is locked.",
    read: () =>
      vaultStore
        .getSnapshot()
        .items.some(
          (item) => item.deletedAt === null && item.kind === "account",
        ),
  },
  {
    id: "vault.has-trash",
    description:
      "The open vault has at least one item in the trash. False while it is locked.",
    read: () =>
      vaultStore.getSnapshot().items.some((item) => item.deletedAt !== null),
  },
  {
    id: "route.vault",
    description: "The person is somewhere in the Vault section.",
    read: () => onRoute("/vault"),
  },
  {
    id: "route.vault.health",
    description: "The person is on the password health report.",
    read: () => onRoute("/vault/health"),
  },
  {
    id: "route.connections",
    description: "The person is somewhere in the Connections section.",
    read: () => onRoute("/connections"),
  },
  {
    id: "route.access",
    description: "The person is in the Access section.",
    read: () => onRoute("/access"),
  },
  {
    id: "route.identity",
    description: "The person is in the Identity section.",
    read: () => onRoute("/identity"),
  },
  {
    id: "route.settings",
    description: "The person is somewhere in Settings.",
    read: () => onRoute("/settings"),
  },
  {
    id: "route.settings.security",
    description: "The person is on the Security settings category.",
    read: () => onRoute("/settings/security"),
  },
  {
    id: "host.connected",
    description:
      "A remote authority answered its last reachability probe. Pages never assumes one is present (ADR 0090).",
    read: () => false,
  },
  {
    id: "identity.connected",
    description: "An Identity session is held on this device right now.",
    read: () => currentSession() !== null,
  },
  {
    id: "account.signed-in",
    description:
      "An account is signed in on this device, a guest included: the account menu has an account to sign out of.",
    read: () => describeAccount() !== null,
  },
  {
    id: "signin-service.configured",
    description:
      "A sign-in service address is set, so email and text codes can be sent.",
    read: isRemoteIdentityConfigured,
  },
  {
    id: "vault.key-enrolled",
    description:
      "This vault has a key enrolled (password, PIN or passkey), so a second step has a key to guard.",
    read: () =>
      listAvailableUnlockMethods(vaultStore.getSnapshot().header).length > 0,
  },
  {
    id: "install.offered",
    description:
      "Settings draws an Install panel: this browser has an install to offer or to report that the one-gesture dialog does not cover.",
    read: () => installOffer(),
  },
  {
    id: "connections.any",
    description:
      "The Connections section is showing at least one connection that has not been revoked.",
    read: () => connectionsPresent,
  },
  {
    id: "network.online",
    description: "This browser believes it has a network.",
    read: () => isOnline(),
  },
  {
    id: "shell.wide",
    description:
      "The shell is wide enough for the section rail and the statusline. Below 900px it draws one pane, with a Sections key and a More key in the top bar instead.",
    read: () => !deviceForm().narrow,
  },
  {
    id: "shell.narrow",
    description:
      "The shell is drawn one pane at a time, with a Sections key and a More key in the top bar and no rail or statusline.",
    read: () => deviceForm().narrow,
  },
  {
    id: "shell.keys",
    description:
      "A precise pointer is attached, so Settings draws the Keybindings category.",
    read: () => deviceForm().keys,
  },
  {
    id: "vault.recovery-made",
    description:
      "This vault has recovery codes, so Settings › Security draws a Recovery row.",
    read: () => Boolean(vaultStore.getSnapshot().header?.unlocks?.recovery),
  },
  {
    id: "plugin.surrogate-proxy.panel",
    description:
      "Settings › Capabilities draws the surrogate proxy's panel: a daemon is paired, or this device may pair one.",
    read: () => pluginPanelDrawn("surrogate-proxy"),
  },
  {
    id: "plugin.browser-autofill.panel",
    description:
      "Settings › Capabilities draws the autofill extension's panel: a daemon is paired, or this device may pair one.",
    read: () => pluginPanelDrawn("browser-autofill"),
  },
  {
    id: "support.model-picks",
    description:
      "Settings › Capabilities draws the voice and inference picks under AI. The on-device model contributes that panel, so the picks are absent while it is unapproved.",
    read: () => supportModelPicks(),
  },
];

/**
 * Declares the whole set. The app calls this once at start-up; a second call
 * is a no-op rather than an error, so a hot reload does not take the page
 * down with `guide_predicate_declared_twice`.
 */
export function registerGuidePredicates(): void {
  for (const descriptor of GUIDE_PREDICATES) {
    if (isKnownGuidePredicate(descriptor.id)) continue;
    declareGuidePredicate(descriptor);
  }
}

export function guidePredicateDescriptors(): readonly GuidePredicateDescriptor[] {
  return GUIDE_PREDICATES;
}
