/**
 * Vault targets — the list, its filters and the ways items get in.
 *
 * Split out of `catalog.ts` the way the identity and setup catalogs already
 * are: one file per area, spread back into `GUIDE_TARGETS` in authoring order.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name or any other value a person authored — the whole catalog
 * is handed to a model as page context.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const VAULT_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "vault.list",
    description:
      "The item list pane. Everything the vault holds is listed here, grouped by folder and narrowed by whichever filter is active.",
    role: "surface",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.create",
    description:
      "Starts a new vault item of the kind the current filter names, defaulting to a login. Opens the editor; nothing is stored until it is saved.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.import",
    description:
      "Opens the file picker for an import from another password manager or a .env file, then hands the chosen file to the Settings import panel.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.filter",
    description:
      "Opens the list of filters — favorites, each item type this vault holds, your folders, and the trash — with the count each would show. Narrowing the list never changes an item. On a wide screen the same roads are in the rail and this key is not drawn.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.favorites",
    description: "Narrows the item list to the items marked as favorites.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.logins",
    description:
      "Narrows the item list to logins. Present only while the vault holds at least one login.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.health.summary",
    description:
      "The one-line verdict of the health report: how many passwords were reviewed, how many are clean, and how many are weak, reused or old.",
    role: "status",
    routes: ["/vault/health"],
    capabilityId: null,
  },
  {
    id: "vault.health.findings",
    description:
      "The list of items the health report wants attention on, each with the reason and a way to open its editor.",
    role: "surface",
    routes: ["/vault/health"],
    capabilityId: null,
  },
];
