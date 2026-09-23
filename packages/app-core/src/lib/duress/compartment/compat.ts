/**
 * Metadata-view helpers for UI lists that already carry compartment tags.
 * These are NOT a substitute for openPresentation / independent keys (INV-05).
 * Callers must only pass items from cryptographically admitted compartments.
 */

import type { PresentationClass } from "../access/context.js";

export type VaultItemView = Readonly<{
  id: string;
  compartmentRef: string;
  title: string;
  sensitive: boolean;
  folder?: string;
  hasTotp?: boolean;
  hasPasskey?: boolean;
  hasAttachment?: boolean;
  connectorRef?: string | null;
}>;

export type ProjectionQuery = Readonly<{
  search?: string;
  folder?: string;
}>;

export function projectVisibleItems(
  items: readonly VaultItemView[],
  admittedCompartmentRefs: readonly string[],
  presentation: PresentationClass,
  query: ProjectionQuery = {},
): VaultItemView[] {
  if (presentation === "locked" || presentation === "unchanged") return [];
  let visible: VaultItemView[];
  if (presentation === "normal" && admittedCompartmentRefs.length === 0) {
    visible = [...items];
  } else {
    const allow = new Set(admittedCompartmentRefs);
    visible = items.filter((item) => allow.has(item.compartmentRef));
  }
  if (query.folder) {
    visible = visible.filter((i) => i.folder === query.folder);
  }
  if (query.search) {
    const q = query.search.toLowerCase();
    visible = visible.filter((i) => i.title.toLowerCase().includes(q));
  }
  return visible;
}

export type ProjectCounts = Readonly<{
  total: number;
  folders: number;
  totp: number;
  passkeys: number;
  attachments: number;
}>;

export function projectCounts(
  items: readonly VaultItemView[],
  admitted: readonly string[],
  presentation: PresentationClass,
): ProjectCounts {
  const visible = projectVisibleItems(items, admitted, presentation);
  return {
    total: visible.length,
    folders: new Set(visible.map((i) => i.folder ?? i.compartmentRef)).size,
    totp: visible.filter((i) => i.hasTotp).length,
    passkeys: visible.filter((i) => i.hasPasskey).length,
    attachments: visible.filter((i) => i.hasAttachment).length,
  } satisfies ProjectCounts;
}

export function decoyConnectorAllowed(
  presentation: PresentationClass,
  explicitSafeApproval: boolean,
): boolean {
  if (presentation !== "decoy" && presentation !== "restricted") return true;
  return explicitSafeApproval;
}

export function projectConnectors(
  connectorRefs: readonly string[],
  presentation: PresentationClass,
  explicitSafeApprovals: ReadonlySet<string>,
): string[] {
  if (presentation === "locked" || presentation === "unchanged") return [];
  if (presentation === "decoy" || presentation === "restricted") {
    return connectorRefs.filter((ref) => explicitSafeApprovals.has(ref));
  }
  return [...connectorRefs];
}

export function resolveDecoyOrLocked(
  decoyAvailable: boolean,
  decoyCorrupt: boolean,
): PresentationClass {
  if (!decoyAvailable || decoyCorrupt) return "locked";
  return "decoy";
}

export type LimitedCarrySelection = Readonly<{
  itemIds: readonly string[];
  consentedAt: string;
  restoreContextId: string;
}>;

export function selectLimitedCarry(
  items: readonly VaultItemView[],
  itemIds: readonly string[],
  restoreContextId: string,
  at = new Date(),
): LimitedCarrySelection {
  const allow = new Set(itemIds);
  const chosen = items.filter((i) => allow.has(i.id));
  if (chosen.length !== itemIds.length) {
    throw new Error("limited_carry_unknown_item");
  }
  return {
    itemIds: chosen.map((i) => i.id),
    consentedAt: at.toISOString(),
    restoreContextId,
  };
}

export function projectLimitedCarry(
  items: readonly VaultItemView[],
  selection: LimitedCarrySelection | null,
  presentation: PresentationClass,
): VaultItemView[] {
  if (!selection) return [];
  if (presentation === "locked" || presentation === "unchanged") return [];
  const allow = new Set(selection.itemIds);
  return items.filter((i) => allow.has(i.id));
}

export function canRestoreLimitedCarry(
  selection: LimitedCarrySelection,
  activeContextId: string,
): boolean {
  return (
    selection.restoreContextId !== activeContextId &&
    selection.itemIds.length > 0
  );
}

export function assertNoCrossCompartmentLeak(
  visible: readonly VaultItemView[],
  admitted: readonly string[],
): void {
  const allow = new Set(admitted);
  for (const item of visible) {
    if (!allow.has(item.compartmentRef)) {
      throw new Error("compartment_leak");
    }
  }
}
