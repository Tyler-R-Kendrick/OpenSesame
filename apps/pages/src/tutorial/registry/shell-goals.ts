/**
 * Shell command-bar walkthrough — kept out of `goals.ts` so that file's
 * recorded line debt does not rise (ADR 0093).
 */

import type { GuideGoalDescriptor } from "./goals.js";

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
      'focus "vault.import" "This opens the file picker, then Settings → Vault data finishes the merge." side=bottom',
      'wait target "vault.import" event=activate timeout=60000',
      'success "Choose an export to import. The items land sealed in this vault."',
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
      'focus "shell.command-bar" "Type a command here, or hold the mic to speak one. Voice language and freer phrasing are under Settings → Connectivity → AI models." side=bottom',
      "end",
    ].join("\n"),
  },
];
