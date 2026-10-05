/**
 * One tour per category of Settings, and one for each row a person comes to
 * Settings to use: the idle timer, the master password, the recovery codes.
 *
 * A tour points at a category or a row and says what it does. It never presses
 * anything and never asks for a secret: a row that opens a sheet is pointed at,
 * and the sheet is where the person types. A row that is drawn only in some
 * states says so (`requires`), because a Settings row acts or is not drawn
 * (ADR 0158) and a tour must not point at one that is not there.
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const SETTINGS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.general.review",
    title: "Tour Settings: General",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.general.review"',
      'say "General is how the app looks and when it locks itself. Nothing on it changes the keys that open the vault."',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.general" "General is the first category. Appearance chooses System, Day or Night. Locking sets the idle timer, how long a copied secret stays on the clipboard, and whether the vault locks when this tab goes to the background." side=bottom',
      'success "That is General."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.keybindings.review",
    title: "Tour Settings: Keybindings",
    routes: ["/settings"],
    libraryOnly: true,
    requires: ["shell.keys"],
    guide: [
      "guide/1",
      'goal "settings.keybindings.review"',
      'say "Every key the app answers to is a command, and the keys that run it are yours to change."',
      'navigate "/settings/keybindings"',
      'wait route "/settings/keybindings" timeout=15000',
      'focus "settings.keybindings" "Keybindings lists every command with its keys as keycaps. Press a keycap to record another key or a sequence of keys. A command that asks before it acts, like trash or share, keeps its place and no key can be moved onto it." side=bottom',
      'say "Below the commands are macros: named lists of steps bound to a key, or run when the vault unlocks or a section opens. A macro never runs a command that asks first."',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'success "That is Keybindings. Tab, Enter, Escape and F6 are fixed, so the keyboard always has a way through."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.capabilities.review",
    title: "Tour Settings: Capabilities",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.capabilities.review"',
      'say "Most of OpenSesame is on from the start. Capabilities is where the optional parts are switched on, one section at a time."',
      'navigate "/settings/capabilities"',
      'wait route "/settings/capabilities" timeout=15000',
      'focus "settings.capabilities" "Capabilities is the category for it: which optional features this installation has selected, what each one would expose, and the way to add or remove one." side=bottom',
      'focus "settings.connectivity" "Every section is drawn like this one: a subheader with its providers under it, and a switch on the subheader where the section has something optional to turn on. Each has a replayable tour of its own in Support." side=bottom',
      'success "That is Capabilities."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.vaults.review",
    title: "Tour Settings: Vaults",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.vaults.review"',
      'say "A device can hold several vaults: your own, one for each project, and a guest session beside them. This category lists them."',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "settings.vaults" "Vaults lists every vault this device holds, with a key to seal a new one, a row to open each, and a key to delete a project vault that is not open. Below it are the item types the vaults can hold." side=bottom',
      'success "That is Vaults."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.danger.review",
    title: "Tour Settings: Danger",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.danger.review"',
      'say "Danger holds what cannot be undone. A deletion here asks twice: the first press arms the key, and nothing is deleted until the second."',
      'navigate "/settings/danger"',
      'wait route "/settings/danger" timeout=15000',
      'focus "settings.danger" "Danger is the last category. It deletes this vault from this browser, and it holds the trash: restore an item, delete it for good, or empty the trash. Export first if you are not certain." side=bottom',
      'success "That is Danger."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.auto-lock.set",
    title: "Set how long the vault stays open",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.auto-lock.set"',
      'say "The vault can lock itself after it has been idle. Locking drops the keys held in memory, and your unlock method opens it again."',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.auto-lock" "Choose only when I ask, or an idle time from one minute to twenty-four hours." side=top',
      'wait target "settings.auto-lock" event=activate timeout=60000',
      'say "Under it, copied secrets are cleared from the clipboard after the time you set, and a switch locks the vault the moment this tab goes to the background."',
      'success "That is the idle timer."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.master-password.change",
    title: "Change the master password",
    routes: ["/settings/security"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vault.master-password.change"',
      'say "The master password is one of the keys that open this vault. Changing it re-wraps the vault key; no item is re-encrypted."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.master-password" "Add sets a master password where there is none, and Change replaces it. Either opens a sheet, and the password is typed there, never in a tour. It takes twelve characters or more." side=left',
      'wait target "settings.master-password" event=activate timeout=60000',
      'success "The sheet is where the new password is typed."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.recovery.view",
    title: "See which recovery codes are left",
    routes: ["/settings/security"],
    libraryOnly: true,
    requires: ["vault.recovery-made"],
    guide: [
      "guide/1",
      'goal "vault.recovery.view"',
      'say "Recovery codes are ten one-time codes that each stand in for the second step once. They were made with the first second step and shown once."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.recovery" "The Recovery row. View recovery codes shows which codes are left, and Make a new set replaces them all." side=top',
      'wait target "settings.recovery" event=activate timeout=60000',
      'success "Keep the codes somewhere the phone is not."',
      "end",
    ].join("\n"),
  },
];

/**
 * The SOPS tour. The SOPS row is drawn by the `backup.cloud-secrets`
 * capability, so the tour arrives with it as a `tutorial-goal` contribution.
 */
export const SOPS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.sops-document.open",
    title: "Open a SOPS document",
    routes: ["/settings/security"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.sops-document.open"',
      'say "SOPS keeps a secrets file encrypted in place. Here a SOPS YAML or JSON file can be opened, unlocked with an age identity you hold, edited and saved back as ciphertext, all in this browser."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'scroll "settings.sops-document"',
      'focus "settings.sops-document" "The SOPS document key opens the sheet where you choose the file. It needs no account and no network." side=top',
      'wait target "settings.sops-document" event=activate timeout=60000',
      'success "Choose a file in the sheet, unlock it with your age identity, and save when you are done."',
      "end",
    ].join("\n"),
  },
];
