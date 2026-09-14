/**
 * Shell targets — the rail, the statusline and the phone chrome.
 *
 * Split out of `catalog.ts` the way the vault, identity and setup catalogs
 * already are: one file per area, spread back into `GUIDE_TARGETS` in
 * authoring order.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address or any other value a person authored —
 * the whole catalog is handed to a model as page context.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const SHELL_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "nav.menu",
    description:
      "Opens the list of sections on a phone. A wide screen draws the same list as the rail and this key is not there.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.vault",
    description:
      "Rail entry that opens the Vault, where every stored login, passkey, card, secret and note lives.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.connections",
    description:
      "Rail entry that opens Connections, where provider connections are added, tested and revoked.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.access",
    description:
      "Rail entry that opens Access, where delegations, share offers and running agent tasks are reviewed.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.identity",
    description:
      "Rail entry that opens Identity, where accounts, upstream providers and linked identities are managed.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.settings",
    description:
      "Rail entry that opens Settings, covering general preferences, security, connectivity, vault data and destructive actions.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "shell.lock",
    description:
      "Locks the vault immediately, dropping the in-memory keys. The master password is needed to open it again.",
    role: "action",
    routes: [],
    capabilityId: null,
  },
  {
    id: "shell.account",
    description:
      "The account segment of the shell prompt (who@vault:/); opens the menu that names the signed-in account, switches org profiles, and offers to attach another account, switch account, or sign out.",
    role: "action",
    routes: [],
    capabilityId: "identity.signout",
  },
  {
    id: "shell.notifications",
    description:
      "Statusline bell listing notices that need a person: pending links, failed syncs, expiring items.",
    role: "status",
    routes: [],
    capabilityId: null,
  },
  {
    id: "shell.connectivity",
    description:
      "Statusline strip reporting whether the Host plane and the Identity plane are reachable right now.",
    role: "status",
    routes: [],
    capabilityId: "host.health.pages",
  },
  {
    id: "shell.support",
    description:
      "Opens in-product support, where a question about the interface can be asked in plain language.",
    role: "surface",
    routes: [],
    capabilityId: "client.support",
  },
];
