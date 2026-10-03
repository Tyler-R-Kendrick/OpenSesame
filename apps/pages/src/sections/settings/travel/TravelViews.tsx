/**
 * The words and small pieces of Settings › Vaults › Travel (ADR 0143): what
 * a refusal means, what a departure reports, the row a safe-list entry is
 * drawn as. Nothing here reads storage or a secret beyond what it is handed.
 */

import type {
  DeparturePackage,
  DepartureReceipt,
} from "@opensesame/app-core/lib/travel/index.js";
import type { ReactNode } from "react";
import type { StatusTone } from "../../../components/StatusMark.js";

/** What a refusal code means, in the panel's words. */
const REFUSAL_TEXT = new Map<string, string>([
  ["owner_not_present", "Open one of your own vaults first"],
  [
    "open_vault_departs",
    "The open vault travels — mark it safe, or open another",
  ],
  ["nothing_departs", "Every vault is marked safe; nothing would leave"],
  ["unknown_vault", "That vault is no longer on this device"],
  ["duress_active", "Not while a duress response holds this device"],
  ["storage_not_durable", "This browser is not keeping files for this site"],
  ["vault_has_no_files", "A vault marked to leave has nothing stored"],
  [
    "vault_needs_opening",
    "A vault is in the old format; open it once, then pack again",
  ],
  [
    "self_check_failed",
    "The bundle did not open with its own code; nothing was removed",
  ],
  ["changed_since_packed", "A vault changed after packing; pack again"],
  ["not_acknowledged", "Confirm where the bundle and the code are"],
  ["code_malformed", "That return code has a typo in it"],
  ["code_mismatch", "That return code does not open this bundle"],
  ["foreign_file", "This bundle carries files that are not a vault's; refused"],
  ["unsupported_version", "This bundle was written by a newer version"],
  ["bundle_too_large", "That file is larger than any travel bundle"],
]);

export function travelRefusalText(code: string): string {
  return REFUSAL_TEXT.get(code) ?? "That is not a travel bundle";
}

/** Something the panel has to say: a refusal, or what just happened. */
export type TravelNotice = { tone: StatusTone; text: string; meta?: string };

export function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

export function TravelRow({
  name,
  meta,
  side,
}: {
  name: string;
  meta?: string;
  side?: ReactNode;
}) {
  return (
    <li className="travel__row">
      <span className="travel__name">
        <strong>{name}</strong>
        {meta ? <span>{meta}</span> : null}
      </span>
      {side ? <span className="travel__side">{side}</span> : null}
    </li>
  );
}

export function saveBundle(pkg: DeparturePackage): void {
  const blob = new Blob([pkg.bundleJson], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pkg.bundleFileName;
  link.click();
  // Revoking synchronously can cancel the download in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function departedNotice(receipt: DepartureReceipt): TravelNotice {
  const removed = `${plural(receipt.removedFiles, "file")} removed`;
  const text = `${plural(receipt.departed.length, "vault")} left this device`;
  return receipt.completion === "applied_local"
    ? { tone: "ok", text, meta: removed }
    : {
        tone: "warn",
        text,
        meta: `${removed} · ${receipt.leftovers.length} could not be`,
      };
}
