/**
 * Shell command-bar walkthrough — kept out of `goals.ts` so that file's
 * recorded line debt does not rise (ADR 0093).
 */

import { DURESS_GOALS, DURESS_HELP } from "./duress-goals.js";
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
    title: "Merge a sealed-store manifest by path",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.store-manifest"',
      'say "A store path manifest is the plain-text list of paths the command-line sealed store seals into entries. Importing one merges it by path: a path already in the vault is updated, a new one is added, and nothing is duplicated."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.import" "Import reads the manifest and shows what merging it would add and update before anything is written." side=bottom',
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
      'say "The command bar is the one typed field in the frame. A command runs; a sentence it cannot parse goes to Support as a question."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.command-bar" "Type a command: go to a section, search, or copy a field. Enter runs it." side=bottom',
      "end",
    ].join("\n"),
  },

  ...DURESS_GOALS,
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
  ...DURESS_HELP,
];
