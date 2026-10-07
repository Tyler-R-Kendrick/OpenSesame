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
    id: "vault.workflow.open",
    description:
      "Open the password workflow sheet from the toolbar or phone Add menu.",
    role: "action",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "vault.workflow.find_references",
  },
  {
    id: "vault.workflow.find",
    description: "Find several title queries as metadata and references.",
    role: "action",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "vault.workflow.find_references",
  },
  {
    id: "vault.workflow.inventory",
    description: "List metadata-only vault inventory.",
    role: "action",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "vault.workflow.inventory",
  },
  {
    id: "vault.workflow.audit",
    description: "Review credential organization audit results.",
    role: "action",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "vault.workflow.audit_organization",
  },
  {
    id: "vault.workflow.template",
    description:
      "Create reference templates; optionally choose a private plaintext download.",
    role: "action",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "vault.workflow.env_template",
  },
  {
    id: "vault.workflow.read",
    description:
      "Read a locally held reference after a deliberate plaintext download choice.",
    role: "action",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "password_provider.read",
  },
  {
    id: "vault.workflow.private",
    description:
      "Privately create credentials, compare a candidate or verify an update.",
    role: "surface",
    routes: ["/vault", "/vault/password-workflows"],
    capabilityId: "vault.workflow.compare_private",
  },

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
      "Starts a new vault item of the kind the current filter names, defaulting to an account. Opens the editor; nothing is stored until it is saved.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.import",
    description:
      "Opens the file picker for an export from another password manager, a .env file or an OpenSesame encrypted backup. The chosen file is read on this device and previewed in a sheet beside the list; nothing is written until its one commit is pressed.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.import",
  },
  {
    id: "vault.filter",
    description:
      "The vault's filters: favorites, each item type this vault holds, your folders and the trash, with the count each would show. Narrowing the list never changes an item. They are rows of the section tree, on a wide screen and on a phone's first screen; in a phone's list one key opens the same roads as a sheet.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.favorites",
    description:
      "Narrows the item list to the items marked as favorites. A row of the filters, always drawn.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.logins",
    description:
      "Narrows the item list to accounts. Present only while the vault holds at least one account.",
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
  {
    id: "item.favorite",
    description:
      "The star on an open item: marks it as a favorite, or takes the mark off. A favorite is listed under the Favorites filter and starred in the list.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.edit",
    description:
      "Opens the open item in the editor, with the fields it was made with. Nothing changes until the editor saves.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.trash",
    description:
      "Moves the open item to the trash. It stays sealed there and can be restored; only deleting it from the trash erases it.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.copy-username",
    description:
      "Copies the open account's username to the clipboard. Drawn only when the account has a username.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
  },
  {
    id: "item.copy-password",
    description:
      "Copies the open account's password to the clipboard without showing it. The clipboard is cleared again when the vault locks, and after the delay set in Settings if there is one. Drawn only when the login has a password.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
  },
  {
    id: "trash.restore",
    description:
      "Restores the trash's selected item to the list, as it was. Drawn while the trash is showing.",
    role: "action",
    routes: ["/vault/trash"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "trash.purge",
    description:
      "Deletes the trash's selected item for good. The first press arms it and asks again; the second erases the sealed record, and nothing brings it back. Drawn while the trash is showing.",
    role: "action",
    routes: ["/vault/trash"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.credentials.references",
    description:
      "Credential fields on the open account or credential, or contextual reference tools on another item. Reveal and copy controls stay beside each value; reference templates and deliberate private downloads appear when available.",
    role: "surface",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
  },
  {
    id: "item.credentials.compare",
    description:
      "Private password comparison and verified update for the selected login. Human input remains in the vault.",
    role: "surface",
    routes: ["/vault/item"],
    capabilityId: "vault.workflow.compare_private",
  },
  {
    id: "vault.health.organization",
    description:
      "Metadata organization findings alongside password health, linking each finding to its actual item.",
    role: "surface",
    routes: ["/vault/health"],
    capabilityId: "vault.workflow.audit_organization",
  },
];
