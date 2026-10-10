/**
 * Tutorials for what a person does with an item that is already in the vault:
 * find it, mark it, edit it, copy from it, set it aside, and see the vaults a
 * device holds (ADR 0163 §6).
 *
 * A tour points at the item's own controls, so it opens the pane of an item
 * (`/vault/item`) and, for the trash, the trash itself (`/vault/trash`); both
 * are places a tour may name without naming an item (`vault-routes.ts`). They
 * need an item to open, so they are offered only where `vault.has-items`
 * holds. The accounts filter and the username and password copy keys exist
 * only while the vault holds an account (`vault.has-account`). A minimal
 * install can seed a secret and nothing else, so those tours stay off there.
 * Trash and delete forever are locked keys (ADR 0156): the tours point
 * at them, and at restore beside them, say what they do, and never press or
 * bind one.
 *
 * Every string is a checked-in literal: nothing here names an item.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

const NEEDS_ITEM = ["vault.has-items"] as const;
const NEEDS_ACCOUNT = ["vault.has-items", "vault.has-account"] as const;

export const VAULT_ITEM_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.item.find",
    title: "Find an item: filters and search",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ITEM,
    guide: [
      "guide/1",
      'goal "vault.item.find"',
      'say "Finding an item is narrowing the list, by a filter or by words typed in the command bar. Neither one changes an item."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.filter" "The filters: all items, favorites, each type this vault holds, your folders and the trash. Each shows the count it would list. Pick one to narrow the list to it. Health, beside them, opens the password health report and does not narrow the list." side=right',
      'focus "vault.filter.favorites" "Favorites lists the items you starred." side=right',
      'focus "shell.command-bar" "Search is done in the command bar. Press / and the bar holds /? ready for words; the list narrows as you type, Enter hands the keyboard to the list, and Esc empties the search." side=bottom',
      'success "Search narrows whichever list is on screen, so pick a filter first to search inside it."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.accounts",
    title: "Narrow the list to accounts",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ACCOUNT,
    guide: [
      "guide/1",
      'goal "vault.item.accounts"',
      'say "A type is listed among the filters once the vault holds one. Accounts lists only accounts."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.filter.logins" "Accounts lists only accounts." side=right',
      'success "Search still narrows whichever list is on screen, so this filter searches inside accounts."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.favorite",
    title: "Favorite an item",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ITEM,
    guide: [
      "guide/1",
      'goal "vault.item.favorite"',
      'say "A favorite is a star on an item. Starred items are listed under the Favorites filter, and carry the star in the list."',
      'navigate "/vault/item"',
      'wait route "/vault/item" timeout=15000',
      'focus "item.favorite" "The star marks the open item as a favorite, or takes the mark off. Press . on a row of the list to do the same for the row under the cursor." side=bottom',
      'success "Favorites is one of the filters beside All items."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.edit",
    title: "Edit an item",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ITEM,
    guide: [
      "guide/1",
      'goal "vault.item.edit"',
      'say "Editing opens an item in the same editor a new item is made in, with its fields as they were. Nothing is stored until you save."',
      'navigate "/vault/item"',
      'wait route "/vault/item" timeout=15000',
      'focus "item.edit" "Edit opens the open item in the editor. In the list, press e on a row to open its editor." side=bottom',
      'success "Save keeps your changes. Cancel leaves the item as it was."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.copy",
    title: "Copy a username or a password",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ACCOUNT,
    guide: [
      "guide/1",
      'goal "vault.item.copy"',
      'say "Copying puts a value on the clipboard without showing it. The clipboard is cleared again when the vault locks, and after the delay set in Settings, if there is one."',
      'navigate "/vault/item"',
      'wait route "/vault/item" timeout=15000',
      'focus "item.copy-username" "Copy username. In the list, press u on a row to copy the username of the row under the cursor." side=bottom',
      'focus "item.copy-password" "Copy password. In the list, press y on a row to copy its password or secret value." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.trash",
    title: "Trash, restore and delete an item",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ITEM,
    guide: [
      "guide/1",
      'goal "vault.item.trash"',
      'say "Trash and delete forever are locked keys: nothing can be remapped onto them, and no macro can run them. This tour only points at the keys for trash, restore and delete; it never presses one."',
      'navigate "/vault/item"',
      'wait route "/vault/item" timeout=15000',
      'focus "item.trash" "Move to trash sets the open item aside. It stays sealed there and can be restored. Press x in the list to trash the row under the cursor." side=bottom',
      'navigate "/vault/trash"',
      'wait route "/vault/trash" timeout=15000',
      'focus "trash.restore" "Restore puts the selected item back in the list as it was. r does the same." side=bottom',
      'focus "trash.purge" "Delete permanently erases the sealed record for good. The first press arms it and asks again; the second erases it. X does the same, and also asks twice." side=bottom',
      'success "Everything in the trash stays sealed until it is deleted from here."',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.manage",
    title: "See the vaults on this device",
    routes: [],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vaults.manage"',
      'say "A device can hold several vaults. Settings → Vaults lists every one, and is the one place a project vault is created or deleted."',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "vaults.list" "Each row is a vault: its name, when it was sealed and how it opens. Press a row to switch to it. The delete key on a project vault asks first, and is never on the personal vault or the one that is open." side=top',
      'success "The plus key in this panel head seals a new vault."',
      "end",
    ].join("\n"),
  },
];
