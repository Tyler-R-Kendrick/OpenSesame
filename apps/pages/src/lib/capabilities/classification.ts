/**
 * Source classification (S02-A): every executable root and optional
 * functional family of the Pages app, as data the build plugin (S07) reads
 * to decide what reaches which chunk and what a hardened build may not emit.
 *
 * A rule is a path prefix relative to `apps/pages`, or `node_modules/<pkg>`
 * for an exclusive external package. The most specific (longest) matching
 * prefix wins. Three classifications:
 *
 * - `core`     — statically linked into the entry; present in every build.
 * - `shared`   — infrastructure several capabilities import (a hook, a store
 *                append API, a codec). Present in every build, owns no
 *                feature, and must never import optional feature code.
 * - `optional` — owned by exactly one optional capability; reachable only
 *                through that capability's module.
 *
 * Nothing here is a heuristic over directories: a mixed module is classified
 * by its *core* side and listed in `MIXED_MODULES` with the extraction its
 * owner must make. The test walks every `.ts`/`.tsx` under `src` and `auth`
 * and fails on a file no rule matches.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import { optionalCapabilityIds } from "./catalog.js";
import { LIB_RULES } from "./classification-lib.js";
import { PACKAGE_RULES } from "./classification-packages.js";
import { SECTION_RULES } from "./classification-sections.js";
import { SHELL_RULES } from "./classification-shell.js";
import { TUTORIAL_RULES, VAULT_LIB_RULES } from "./classification-vault.js";

export type SourceClass = "core" | "shared" | "optional";

export type SourceClassification = Readonly<{
  /** Path prefix relative to apps/pages, or `node_modules/<pkg>`. */
  pattern: string;
  classification: SourceClass;
  capability: CapabilityId | null;
  rationale: string;
}>;

/** `src/modules/<id>/` is owned by `<id>` verbatim (ownership.md §4.3). */
const MODULE_RULES: readonly SourceClassification[] =
  optionalCapabilityIds().map((id) => ({
    pattern: `src/modules/${id}/`,
    classification: "optional",
    capability: id,
    rationale: "capability runtime module directory",
  }));

export const SOURCE_CLASSIFICATION: readonly SourceClassification[] = [
  ...MODULE_RULES,
  ...SHELL_RULES,
  ...SECTION_RULES,
  ...LIB_RULES,
  ...VAULT_LIB_RULES,
  ...TUTORIAL_RULES,
  ...PACKAGE_RULES,
];

/**
 * A prefix ending in `/` or `-` matches anything under it; any other prefix
 * matches the exact path or a continuation by `.`, `-` or `/`, so
 * `src/lib/push` matches `push.ts` and `push.test.ts`, and `src/lib/local-`
 * matches every `local-*.ts`.
 */
export function ruleMatches(pattern: string, path: string): boolean {
  if (!path.startsWith(pattern)) return false;
  if (pattern.endsWith("/") || pattern.endsWith("-")) return true;
  const next = path.charAt(pattern.length);
  return next === "" || next === "." || next === "-" || next === "/";
}

/** The winning rule for a path, or `null` when nothing matches. */
export function classify(path: string): SourceClassification | null {
  let best: SourceClassification | null = null;
  for (const rule of SOURCE_CLASSIFICATION) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (best === null || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best;
}

export type MixedModule = Readonly<{
  path: string;
  /** What stays where it is (the classification the rule gives the file). */
  keeps: string;
  /** Extractions the owning agent must make, one per optional capability. */
  extract: readonly Readonly<{ capability: CapabilityId; what: string }>[];
}>;

export { MIXED_MODULES } from "./classification-mixed.js";
