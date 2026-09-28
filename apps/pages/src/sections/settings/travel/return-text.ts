/**
 * Coming home in Settings › Vaults › Travel (ADR 0143), as words: the
 * bundle's vaults as they would return, the site grants they carry — brought
 * back only on the person's word — and what a return or a clear reports.
 */

import type {
  ClearRemnantsOutcome,
  ReturnPreview,
  ReturnReceipt,
  ReturnStatus,
} from "@opensesame/app-core/lib/travel/index.js";
import { vaultLabel } from "@opensesame/app-core/lib/vaults.js";
import { type TravelNotice, plural } from "./TravelViews.js";

const STATUS = {
  comes_home: "Comes home",
  already_home: "Already home",
  occupied: "Already here, not the same; left alone",
} satisfies Record<ReturnStatus, string>;

/** The sites the returning vaults' grants would let in. */
export function sitesComing(preview: ReturnPreview): string[] {
  const coming = preview.vaults.filter((v) => v.status === "comes_home");
  return [...new Set(coming.flatMap((v) => v.grants.sites))].sort();
}

/** A row's grants, named only where the vault is coming home. */
function grantMeta(vault: ReturnPreview["vaults"][number]): string {
  const sites = vault.grants.sites.length;
  return vault.status === "comes_home" && sites > 0
    ? plural(sites, "site grant")
    : "";
}

export function returnedNotice(receipt: ReturnReceipt): TravelNotice {
  const text = `${plural(receipt.restored.length, "vault")} came home`;
  const aside = [
    receipt.grantsRestored.length > 0 ? "site grants restored" : "",
    receipt.alreadyHome.length > 0
      ? `${plural(receipt.alreadyHome.length, "vault")} already here`
      : "",
    receipt.occupied.length > 0
      ? `${plural(receipt.occupied.length, "vault")} left alone`
      : "",
  ].filter(Boolean);
  return {
    tone: receipt.occupied.length > 0 ? "warn" : "ok",
    text,
    meta: aside.join(" · ") || undefined,
  };
}

export function remnantsNotice(
  outcome: Extract<ClearRemnantsOutcome, { ok: true }>,
): TravelNotice {
  return outcome.leftovers.length === 0
    ? { tone: "ok", text: "Leftovers cleared" }
    : {
        tone: "warn",
        text: "Leftovers cleared",
        meta: `${plural(outcome.leftovers.length, "file")} could not be`,
      };
}

/** The preview's facts: one per vault in the bundle, what would happen to it. */
export function previewFacts(
  preview: ReturnPreview,
): { key: string; value: string }[] {
  return preview.vaults.map((vault) => ({
    key: vaultLabel({ id: vault.id, name: vault.name ?? vault.id }),
    value: [plural(vault.files, "file"), grantMeta(vault), STATUS[vault.status]]
      .filter(Boolean)
      .join(" · "),
  }));
}

/** Whether any vault in the preview would come home. */
export function anyComesHome(preview: ReturnPreview): boolean {
  return preview.vaults.some((vault) => vault.status === "comes_home");
}
