/**
 * Shell command-bar walkthrough — kept out of `goals.ts` so that file's
 * recorded line debt does not rise (ADR 0093).
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const SHELL_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.import",
    title: "Import items from another password manager",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.import"',
      'say "Import takes a .env, .csv, .json, .1pux, .zip or .kdbx export and merges it into this vault. Nothing leaves the device."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.import" "This opens the file picker; the file is previewed in a sheet beside the list before anything is written." side=bottom',
      'wait target "vault.import" event=activate timeout=60000',
      'success "Choose an export to import. The items land sealed in this vault."',
      "end",
    ].join("\n"),
  },

  {
    id: "vault.store-manifest",
    title: "Move items to and from the sealed store",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.store-manifest"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "vault.store-manifest" "This saves a plain-text manifest for opensesame pass seal to seal and shred. The vault\'s Import key merges one back by path." side=bottom',
      "end",
    ].join("\n"),
  },

  {
    id: "client.command-bar",
    title: "Run a command from the bar",
    routes: [],
    guide: [
      "guide/1",
      'goal "client.command-bar"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.command-bar" "Type a command here, or hold the mic to speak one. Voice language and freer phrasing are under Settings → Connections → AI models." side=bottom',
      "end",
    ].join("\n"),
  },
];

/** The shell's help topics, drawn beside the walkthroughs they open. */
export const SHELL_HELP: readonly HelpTopic[] = [
  {
    id: "help.vault.import",
    title: "How do I bring items in from another password manager?",
    answer:
      "Import sits beside New item in the Vault's path strip, and takes an export from another manager — a .env, .csv, .json, .1pux, .zip or .kdbx file — an OpenSesame encrypted backup, or a sealed-store path manifest, merged by path. The file is read on this device and previewed in a sheet; nothing is written until you confirm it.",
    routes: [],
    goal: "vault.import",
    keywords: [
      "import",
      "migrate",
      "bring",
      "move",
      "1password",
      "bitwarden",
      "lastpass",
      "keepass",
      "kdbx",
      "csv",
      "json",
      "env",
      "another password manager",
      "transfer",
      "manifest",
      "sealed store",
    ],
  },
];
