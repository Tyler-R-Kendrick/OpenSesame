/**
 * Coming home in Settings › Vaults › Travel (ADR 0143): the bundle's vaults
 * as they would return, the site grants they carry — brought back only on
 * the person's word — and the leftovers a cut-short departure can leave.
 */

import type {
  ClearRemnantsOutcome,
  ReturnPreview,
  ReturnReceipt,
  ReturnStatus,
  TravelRemnant,
} from "@opensesame/app-core/lib/travel/index.js";
import { vaultLabel } from "@opensesame/app-core/lib/vaults.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconDownload, IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../../components/StatusMark.js";
import { type TravelNotice, TravelRow, plural } from "./TravelViews.js";

const STATUS = {
  comes_home: { tone: "ok", label: "Comes home" },
  already_home: { tone: "idle", label: "Already home" },
  occupied: { tone: "warn", label: "Already here, not the same; left alone" },
} satisfies Record<ReturnStatus, { tone: StatusTone; label: string }>;

/** The sites the returning vaults' grants would let in. */
function sitesComing(preview: ReturnPreview): string[] {
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

export function ReturnPreviewView({
  preview,
  busy,
  grants,
  onGrants,
  onReturn,
  onCancel,
}: {
  preview: ReturnPreview;
  busy: boolean;
  grants: boolean;
  onGrants: (next: boolean) => void;
  onReturn: () => void;
  onCancel: () => void;
}) {
  const coming = preview.vaults.some((vault) => vault.status === "comes_home");
  const sites = sitesComing(preview);
  return (
    <form
      className="travel"
      aria-label="Coming home"
      onSubmit={(event) => {
        event.preventDefault();
        onReturn();
      }}
    >
      <ul className="travel__list" aria-label="Vaults in the bundle">
        {preview.vaults.map((vault) => (
          <TravelRow
            key={vault.id}
            name={vaultLabel({ id: vault.id, name: vault.name ?? vault.id })}
            meta={[plural(vault.files, "file"), grantMeta(vault)]
              .filter(Boolean)
              .join(" · ")}
            side={
              <StatusMark
                tone={STATUS[vault.status].tone}
                label={STATUS[vault.status].label}
              />
            }
          />
        ))}
      </ul>
      {sites.length > 0 ? (
        <label className="travel__ack">
          <input
            type="checkbox"
            checked={grants}
            disabled={busy}
            onChange={(event) => onGrants(event.target.checked)}
          />
          <span>{`Let these sites in again: ${sites.join(", ")}`}</span>
        </label>
      ) : null}
      <FormCommit
        label="Bring them home"
        icon={<IconDownload size={18} />}
        disabled={busy || !coming}
        busy={busy}
      >
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          title="Close"
          onClick={onCancel}
        >
          <IconX size={16} />
        </button>
      </FormCommit>
    </form>
  );
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

/** Files a cut-short departure left with no header: never openable here. */
export function RemnantsRow({
  remnants,
  busy,
  onClear,
}: {
  remnants: readonly TravelRemnant[];
  busy: boolean;
  onClear: () => void;
}) {
  const files = remnants.reduce((sum, r) => sum + r.files.length, 0);
  const label = "Clear leftover files";
  return (
    <ul className="travel__list" aria-label="Leftovers">
      <TravelRow
        name="Leftovers of a departure"
        meta={plural(files, "file")}
        side={
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={label}
            title={label}
            disabled={busy}
            onClick={onClear}
          >
            <IconTrash size={16} />
          </button>
        }
      />
    </ul>
  );
}
