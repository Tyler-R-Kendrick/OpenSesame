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
    routes: [],
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
    id: "vaults.retired-credentials",
    title: "Detect a retired password",
    routes: [],
    requires: ["vault.unlocked"],
    guide: [
      "guide/1",
      'goal "vaults.retired-credentials"',
      'say "Retired passwords can be enrolled on this device after you authenticate with your current password. Detection records possession of an old password, including stale autofill; it does not identify an attacker."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security" "Open Retired passwords in the Decoy panel. The default records and rejects a match. Synthetic decoy opens an isolated vault with invented items and no production connections. Neither response freezes or wipes your vault." side=bottom',
      'say "Enrollment stores a password-only verifier: consider the risk if that password is reused elsewhere or your vault requires two secrets. Evidence stays on this device. Lock a decoy, then authenticate afresh with your real key to return; anything saved in the decoy is temporary."',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.travel",
    title: "Prepare a vault for travel",
    routes: [],
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
    routes: [],
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
    id: "help.vaults.retired-credentials",
    title: "What happens when an old password is used?",
    answer:
      "Settings → Security → Decoy → Retired passwords. Enroll selected old passwords with your current password; matches record retired_credential_observed and are rejected by default. Synthetic decoy is an explicit alternative with invented data and no real authority. There is no freeze or wipe. Stale autofill can cause an observation. Lock the decoy and authenticate again to return to your real vault. Evidence is local and cannot protect a stolen backup.",
    routes: [],
    goal: "vaults.retired-credentials",
    keywords: [
      "retired",
      "old password",
      "honeyword",
      "trap",
      "synthetic",
      "canary",
    ],
  },
  {
    id: "help.vaults.travel",
    title: "How do I protect my vaults when I travel?",
    answer:
      "Settings → Security → Travel, beside Duress. Leave for a trip sends the vaults that are not safe to carry off this device, and Come home from a trip brings them back. It appears once you are in a vault you own.",
    routes: [],
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
