/**
 * Test fixture: the contributions the optional capabilities register on
 * activation, in the shapes their runtimes use (`modules/<id>/runtime.ts`),
 * minus the components. A suite that proved the shell against the
 * hard-coded sections keeps its coverage by registering these (EVID-08);
 * the default, with nothing registered, is the core-only shell.
 */

import type { ComponentType } from "react";
import type {
  SectionContribution,
  TreeProps,
} from "./capabilities/runtime-contract.js";
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

/**
 * The five optional rail directories, without their trees. A module supplies
 * `Tree` as an already-imported component; a test that only needs the row —
 * a crumb, a jump, a command path — registers these as they are.
 */
export const LEGACY_SECTION_ROWS: readonly Omit<SectionContribution, "Tree">[] =
  [
    {
      id: "connections",
      to: "/connections",
      label: "Connections",
      segment: "connections",
      jump: "c",
      icon: "connection",
      order: 20,
    },
    {
      id: "access",
      to: "/access",
      label: "Access",
      segment: "access",
      jump: "a",
      icon: "authority",
      order: 30,
    },
    {
      id: "identity",
      to: "/identity",
      label: "Identity",
      segment: "identity",
      jump: "i",
      icon: "user",
      order: 40,
    },
    {
      id: "wallet",
      to: "/wallet",
      label: "Wallet",
      segment: "wallet",
      jump: "w",
      icon: "card",
      order: 50,
    },
    {
      id: "activity",
      to: "/activity",
      label: "Activity",
      segment: "activity",
      jump: "y",
      icon: "clock",
      order: 60,
    },
  ];

function revokeAll(revokes: readonly (() => void)[]): () => void {
  return () => {
    for (const revoke of revokes) revoke();
  };
}

/** The five rail directories; `trees` supplies each one's entries by id. */
export function registerLegacySectionRows(
  trees: Readonly<Record<string, ComponentType<TreeProps>>> = {},
): () => void {
  return revokeAll(
    LEGACY_SECTION_ROWS.map((row) =>
      registerContributionForTest("section", {
        ...row,
        ...(trees[row.id] ? { Tree: trees[row.id] } : {}),
      }),
    ),
  );
}

function EmptySettingsPanel(): null {
  return null;
}

/** The one contributed Settings category: Connections, from the connectors capability. */
export function registerLegacySettingsCategories(
  Panel: ComponentType = EmptySettingsPanel,
): () => void {
  return registerContributionForTest("settings-category", {
    id: "connections",
    label: "Connections",
    guideId: "settings.connections",
    Panel,
    order: 40,
  });
}

export function registerLegacyJumps(): () => void {
  return revokeAll(
    LEGACY_JUMPS.flatMap((jump) => [
      registerContributionForTest("keymap-jump", {
        key: jump.key,
        path: jump.path,
      }),
      registerContributionForTest("command-path", {
        path: jump.path,
        label: jump.label,
      }),
    ]),
  );
}

export function registerLegacyItemKinds(): () => void {
  return revokeAll(
    LEGACY_ITEM_KINDS.map((kind) =>
      registerContributionForTest("item-kind", kind),
    ),
  );
}

/**
 * Jumps, command paths and item kinds — everything data-shaped. The section
 * rows and the Connections settings category carry components and live in
 * `components/legacy-sections.test-support.tsx`.
 */
export function registerLegacySections(): () => void {
  return revokeAll([registerLegacyJumps(), registerLegacyItemKinds()]);
}

/**
 * Everything but the components: jumps, command paths, item kinds, the five
 * rail directories as leaves, and the Connections settings category with an
 * empty panel. What a non-React test (crumbs, keymap, WebMCP) needs to see
 * the shell a full plan draws.
 */
export function registerLegacyShellData(): () => void {
  return revokeAll([
    registerLegacySections(),
    registerLegacySectionRows(),
    registerLegacySettingsCategories(),
  ]);
}
