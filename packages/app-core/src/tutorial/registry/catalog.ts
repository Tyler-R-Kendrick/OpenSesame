/**
 * The authored target catalog — every control a support guide may point at.
 *
 * These names are the vocabulary the model gets, and they are chosen the way a
 * person would describe the app rather than the way it happens to be built:
 * `nav.connections`, not `.railtree__row:nth-child(2)`. That is what lets the
 * UI be restyled or rebuilt without silently invalidating every tutorial.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address, connection label or any other value a
 * person authored — the whole catalog is handed to a model as page context.
 */

import { contributionsSnapshot } from "../../lib/contributions.js";
import { GUIDE_TARGETS_MORE } from "./catalog-more.js";
import { SHELL_TARGETS } from "./shell-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";
import { VAULT_TARGETS } from "./vault-catalog.js";

/**
 * The targets the core shell always has. Every other control belongs to the
 * capability that draws it and arrives as a `tutorial-target` contribution
 * while that capability is in the plan (`connections-catalog.ts`,
 * `access-catalog.ts`, `identity-catalog.ts`, `wallet-catalog.ts`,
 * `activity-catalog.ts`); `authored.ts` is the whole corpus for a module to
 * pick its entries from.
 */
export const CORE_GUIDE_TARGETS: readonly GuideTargetDescriptor[] = [
  ...SHELL_TARGETS,
  ...VAULT_TARGETS,

  // ── Settings: five categories and the panels people ask about ─────────
  {
    id: "settings.general",
    description:
      "The General settings category: appearance, and how long the vault waits before locking itself.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.security",
    description:
      "The Security settings category: the keys that open this vault, the second steps asked after one, and the recovery codes — each a row with one action that opens the one sheet.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  // Settings › Capabilities draws these in core, before any module lands.
  {
    id: "settings.connectivity",
    description:
      "The providers on Settings › Capabilities: identity providers, encryption, password managers, cloud secret storage and local storage — the connectors of always-on functions.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "host.health.pages",
  },
  {
    id: "settings.backup",
    description:
      "The Backups feature on Settings › Capabilities: switch it on, then choose the git provider the encrypted vault backs up to.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "backup.target.set",
  },
  {
    id: "settings.model-provider",
    description:
      "Under the AI feature: two provider/model slug picks — voice and general inference — from Agent Harnesses connections and built-in local/browser options.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "model_plane.choose",
  },
  {
    id: "settings.age-keys",
    description: "Age recipients and identities for this vault.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.vault-key-protection",
    description:
      "Vault key protection under Security: enrolled methods that can unlock this vault alone, and setup intent that is not yet enrolled.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.formats-interoperability",
    description:
      "Formats under Security: native, age, SOPS, and GPG with separate read, write, and runtime indicators.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.second-step",
    description:
      "The Second step list under Security: the authenticator app, and the email and text codes your sign-in service sends as fallbacks. Each row's Add opens the sheet; nothing turns on until a code from the new method matches.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.second_step.code",
  },
  {
    id: "settings.recovery",
    description:
      "The Recovery row under Security: ten one-time codes that stand in for the second step once each, made with the first second step and shown once; View shows the ones left.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.recovery_codes",
  },
  {
    id: "settings.capabilities",
    description:
      "The Capabilities settings category: which optional features this installation has selected, what each one would expose, and the way to add or remove one.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.vaults",
    description:
      "The Vaults settings category: every vault this device holds — the personal tomb, one per project, the guest tomb — and the way to open, create or remove one (ADR 0089).",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.data",
    description:
      "There is no Vault data settings category. Folders, backup, and the build record live with the surfaces that own them.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "vault.export",
  },
  {
    id: "settings.danger",
    description:
      "The Danger settings category, which holds the irreversible action of deleting this vault from this browser.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.auto-lock",
    description:
      "Chooses how long the vault stays unlocked while idle before its key is dropped from memory.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.master-password",
    description:
      "The master password's row under Unlock methods: it opens the sheet that sets or changes it. The vault key itself is unchanged, so no item is re-encrypted.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: null,
  },

  // ── Statusline detail: the two planes and the health notice ───────────
  {
    id: "connectivity.host",
    description:
      "The identity glyph on the statusline. Its colour reports reachability, and pressing it opens the ceremony that repairs the connection.",
    role: "ceremony",
    routes: [],
    capabilityId: "host.health.pages",
  },
  {
    id: "connectivity.identity",
    description:
      "The sign-in glyph on the statusline. Pressing it opens the ceremony that signs in or reports the session already held.",
    role: "ceremony",
    routes: [],
    capabilityId: "identity.whoami",
  },
  {
    id: "notifications.health",
    description:
      "Link from the notifications sheet into the password health report. Present only while the report has findings.",
    role: "navigation",
    routes: [],
    capabilityId: null,
  },

  ...GUIDE_TARGETS_MORE,
];

let contributedTargets: readonly GuideTargetDescriptor[] | null = null;

/**
 * The live catalog: core targets plus the ones approved capabilities have
 * contributed. A live binding, so a reader that holds the array sees what
 * the accessor last computed; readers call `mergedGuideTargets()` to be sure.
 */
export let GUIDE_TARGETS: readonly GuideTargetDescriptor[] = CORE_GUIDE_TARGETS;

export function mergedGuideTargets(): readonly GuideTargetDescriptor[] {
  const contributed = contributionsSnapshot("tutorial-target");
  if (contributed === contributedTargets) return GUIDE_TARGETS;
  contributedTargets = contributed;
  if (contributed.length === 0) {
    GUIDE_TARGETS = CORE_GUIDE_TARGETS;
    return GUIDE_TARGETS;
  }
  const seen = new Set(CORE_GUIDE_TARGETS.map((target) => target.id));
  const extra: GuideTargetDescriptor[] = [];
  for (const target of contributed) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    extra.push(target);
  }
  GUIDE_TARGETS = Object.freeze([...CORE_GUIDE_TARGETS, ...extra]);
  return GUIDE_TARGETS;
}
