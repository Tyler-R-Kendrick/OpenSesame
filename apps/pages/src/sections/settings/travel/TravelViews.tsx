/**
 * The pieces of Settings › Vaults › Travel (ADR 0143), drawn from state the
 * panel holds. Nothing here reads storage or a secret beyond what it is
 * handed: the return code is shown once, as text to write down — never put
 * on the clipboard, which keeps its own history.
 */

import type {
  DeparturePackage,
  DepartureReceipt,
  ReturnPreview,
  ReturnReceipt,
  ReturnStatus,
} from "@opensesame/app-core/lib/travel/index.js";
import { vaultLabel } from "@opensesame/app-core/lib/vaults.js";
import type { ReactNode } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import {
  IconArrowRight,
  IconDownload,
  IconUpload,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../../components/StatusMark.js";

/** What a refusal code means, in the panel's words. */
export function travelRefusalText(code: string): string {
  switch (code) {
    case "owner_not_present":
      return "Open one of your own vaults first";
    case "open_vault_departs":
      return "The open vault travels — mark it safe, or open another";
    case "nothing_departs":
      return "Every vault is marked safe; nothing would leave";
    case "unknown_vault":
      return "That vault is no longer on this device";
    case "duress_active":
      return "Not while a duress response holds this device";
    case "storage_not_durable":
      return "This browser is not keeping files for this site";
    case "vault_has_no_files":
      return "A vault marked to leave has nothing stored";
    case "self_check_failed":
      return "The bundle did not open with its own code; nothing was removed";
    case "changed_since_packed":
      return "A vault changed after packing; pack again";
    case "not_acknowledged":
      return "Confirm where the bundle and the code are";
    case "code_malformed":
      return "That return code has a typo in it";
    case "code_mismatch":
      return "That return code does not open this bundle";
    case "foreign_file":
      return "This bundle carries files that are not a vault's; refused";
    case "unsupported_version":
      return "This bundle was written by a newer version";
    default:
      return "That is not a travel bundle";
  }
}

export function TravelNotice({
  tone,
  text,
}: {
  tone: StatusTone;
  text: string;
}) {
  return (
    <p className="travel__notice" role={tone === "err" ? "alert" : "status"}>
      <StatusMark tone={tone} label={text} />
      <span>{text}</span>
    </p>
  );
}

function plural(count: number, one: string): string {
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

function saveBundle(pkg: DeparturePackage): void {
  const blob = new Blob([pkg.bundleJson], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pkg.bundleFileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function PackedView({
  pkg,
  ack,
  busy,
  onAck,
  onDepart,
  onCancel,
}: {
  pkg: DeparturePackage;
  ack: { bundleSaved: boolean; codeRecorded: boolean };
  busy: boolean;
  onAck: (next: { bundleSaved: boolean; codeRecorded: boolean }) => void;
  onDepart: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="travel"
      aria-label="Leaving this device"
      onSubmit={(event) => {
        event.preventDefault();
        onDepart();
      }}
    >
      <ul className="travel__list" aria-label="Vaults that leave">
        {pkg.departing.map((vault) => (
          <TravelRow
            key={vault.id}
            name={vault.label}
            meta={plural(vault.files, "file")}
          />
        ))}
        <TravelRow
          name={pkg.bundleFileName}
          meta="travel bundle"
          side={
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Save the travel bundle"
              title="Save the travel bundle"
              onClick={() => saveBundle(pkg)}
            >
              <IconDownload size={16} />
            </button>
          }
        />
      </ul>
      <div>
        <strong id="travel-code-label">Return code</strong>
        <p className="travel__code" aria-labelledby="travel-code-label">
          {pkg.returnCode}
        </p>
      </div>
      <label className="travel__ack">
        <input
          type="checkbox"
          checked={ack.bundleSaved}
          onChange={(event) =>
            onAck({ ...ack, bundleSaved: event.target.checked })
          }
        />
        <span>The bundle is saved somewhere other than this device</span>
      </label>
      <label className="travel__ack">
        <input
          type="checkbox"
          checked={ack.codeRecorded}
          onChange={(event) =>
            onAck({ ...ack, codeRecorded: event.target.checked })
          }
        />
        <span>The return code is written down, and it stays home</span>
      </label>
      <FormCommit
        label="Take them off this device"
        icon={<IconUpload size={18} />}
        disabled={busy || !ack.bundleSaved || !ack.codeRecorded}
        busy={busy}
      >
        <button
          type="button"
          className="icon-btn"
          aria-label="Keep them here"
          title="Keep them here"
          onClick={onCancel}
        >
          <IconX size={16} />
        </button>
      </FormCommit>
    </form>
  );
}

export function departedText(receipt: DepartureReceipt): string {
  return `${plural(receipt.departed.length, "vault")} left this device · ${plural(receipt.removedFiles, "file")} removed`;
}

export function ReturnForm({
  fileName,
  code,
  busy,
  onFile,
  onCode,
  onOpen,
  onCancel,
}: {
  fileName: string | null;
  code: string;
  busy: boolean;
  onFile: (file: File) => void;
  onCode: (next: string) => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="travel"
      aria-label="Coming home"
      onSubmit={(event) => {
        event.preventDefault();
        onOpen();
      }}
    >
      <ul className="travel__list">
        <TravelRow
          name={fileName ?? "No bundle chosen"}
          meta="travel bundle"
          side={
            <label
              className="icon-btn icon-btn--sm"
              title="Choose the travel bundle"
            >
              <IconUpload size={16} />
              <span className="visually-hidden">Choose the travel bundle</span>
              <input
                type="file"
                accept=".json,application/json"
                aria-label="Choose the travel bundle"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) onFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          }
        />
      </ul>
      <FieldShell
        id="travel-return-code"
        label="Return code"
        mono
        autoComplete="off"
        placeholder="ABCD-EFGH-…"
        value={code}
        disabled={busy}
        onValueChange={onCode}
      />
      <FormCommit
        label="Open the bundle"
        icon={<IconArrowRight size={18} />}
        disabled={busy || !fileName || code.trim().length === 0}
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

const STATUS = {
  comes_home: { tone: "ok", label: "Comes home" },
  already_home: { tone: "idle", label: "Already home" },
  occupied: { tone: "warn", label: "Another vault is here; left alone" },
} satisfies Record<ReturnStatus, { tone: StatusTone; label: string }>;

export function ReturnPreviewView({
  preview,
  busy,
  onReturn,
  onCancel,
}: {
  preview: ReturnPreview;
  busy: boolean;
  onReturn: () => void;
  onCancel: () => void;
}) {
  const coming = preview.vaults.some((vault) => vault.status === "comes_home");
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
            meta={plural(vault.files, "file")}
            side={
              <StatusMark
                tone={STATUS[vault.status].tone}
                label={STATUS[vault.status].label}
              />
            }
          />
        ))}
      </ul>
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

export function returnedText(receipt: ReturnReceipt): string {
  const parts = [`${plural(receipt.restored.length, "vault")} came home`];
  if (receipt.occupied.length > 0) {
    parts.push(`${plural(receipt.occupied.length, "vault")} left alone`);
  }
  return parts.join(" · ");
}
