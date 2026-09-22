/**
 * Test fixture: the contributions the optional capabilities register on
 * activation, in the shapes their runtimes use (`modules/<id>/runtime.ts`),
 * minus the components. A suite that proved the shell against the
 * hard-coded sections keeps its coverage by registering these (EVID-08);
 * the default, with nothing registered, is the core-only shell.
 */

import { registerContributionForTest } from "./contributions.js";

/** `keymap-jump` + `command-path` for every legacy section, in rail order. */
export const LEGACY_JUMPS = [
  { key: "c", path: "/connections", label: "Connections", order: 20 },
  { key: "a", path: "/access", label: "Access", order: 30 },
  { key: "i", path: "/identity", label: "Identity", order: 40 },
  { key: "w", path: "/wallet", label: "Wallet", order: 50 },
  { key: "y", path: "/activity", label: "Activity", order: 60 },
] as const;

/** The `item-kind` contributions of the three record capabilities. */
export const LEGACY_ITEM_KINDS = [
  { kind: "passkey", label: "Passkeys", segment: "passkeys", order: 20 },
  { kind: "drop", label: "Drops", segment: "drops", order: 50 },
  { kind: "certificate", label: "Certificates", segment: "certs", order: 70 },
] as const;

export function registerLegacyJumps(): () => void {
  const revokes = LEGACY_JUMPS.flatMap((jump) => [
    registerContributionForTest("keymap-jump", {
      key: jump.key,
      path: jump.path,
    }),
    registerContributionForTest("command-path", {
      path: jump.path,
      label: jump.label,
    }),
  ]);
  return () => {
    for (const revoke of revokes) revoke();
  };
}

export function registerLegacyItemKinds(): () => void {
  const revokes = LEGACY_ITEM_KINDS.map((kind) =>
    registerContributionForTest("item-kind", kind),
  );
  return () => {
    for (const revoke of revokes) revoke();
  };
}

/**
 * Jumps, command paths and item kinds — everything data-shaped. The section
 * rows and the Connections settings category carry components and live in
 * `components/legacy-sections.test-support.tsx`.
 */
export function registerLegacySections(): () => void {
  const revokes = [registerLegacyJumps(), registerLegacyItemKinds()];
  return () => {
    for (const revoke of revokes) revoke();
  };
}
