/**
 * The duress code and travel mode walkthroughs (ADR 0155, ADR 0143) — kept
 * out of `goals.ts` so that file's recorded line debt does not rise
 * (ADR 0093).
 *
 * Both only point: GuideLang has no directive that sets a code, presses a
 * row or starts a trip, and these guides land on Settings → Security and
 * name the rows in prose. Nothing here may interpolate a vault name, a code
 * or any value a person authored.
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const DURESS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vaults.duress-code",
    title: "Set up a duress code",
    routes: ["/settings/security"],
    guide: [
      "guide/1",
      'goal "vaults.duress-code"',
      'say "A duress code is a second code for this device. Typed where a vault unlocks, it shows something else instead of the vault. Only the owner of an open vault can set it, change it or clear it."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security" "The Duress panel is on this page, below the unlock methods. Press Add on its Duress code row to choose the code; Change and Clear replace or remove it." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.travel",
    title: "Prepare a vault for travel",
    routes: ["/settings/security"],
    guide: [
      "guide/1",
      'goal "vaults.travel"',
      'say "Travel mode takes the vaults that are not safe to carry off this device before a trip, and brings them back afterwards. It draws beside the duress code, so it appears once you are in a vault you own."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security" "The Travel panel is on this page, under the Duress panel. Leave for a trip sends the vaults away, and Come home from a trip brings them back." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const DURESS_HELP: readonly HelpTopic[] = [
  {
    id: "help.vaults.duress-code",
    title: "How do I set a duress code?",
    answer:
      "Settings → Security → Duress. A duress code is a second code: typed where a vault unlocks, it opens something else instead of your vault. Add on the Duress code row chooses it; Change and Clear replace or remove it. Only the owner of an open vault can do this.",
    routes: ["/settings/security"],
    goal: "vaults.duress-code",
    keywords: [
      "duress",
      "coercion",
      "coerced",
      "decoy",
      "panic",
      "second code",
      "fake vault",
    ],
  },
  {
    id: "help.vaults.travel",
    title: "How do I protect my vaults when I travel?",
    answer:
      "Settings → Security → Travel, beside Duress. Leave for a trip sends the vaults that are not safe to carry off this device, and Come home from a trip brings them back. It appears once you are in a vault you own.",
    routes: ["/settings/security"],
    goal: "vaults.travel",
    keywords: [
      "travel",
      "trip",
      "border",
      "customs",
      "airport",
      "leave",
      "come home",
      "return",
      "carry",
      "hide vaults",
    ],
  },
];
