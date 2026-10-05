/**
 * Settings › Security › Travel (ADR 0143).
 *
 * Two rows, one action each: turn travel mode on (mark the vaults that are
 * safe to carry; the rest leave this device in a bundle sealed under a
 * return code) and turn it off (bring them back from the bundle and the
 * code). Each opens its ceremony in a sheet. The panel looks the same
 * whether vaults are away or not — there is nothing on the device that
 * knows (ADR 0143 §4) — so a row states what it can do now, never a mode.
 */

import { type ReactNode, useState } from "react";
import { useDeviceVaults } from "../../../bindings/vaults.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconDownload,
  IconTrash,
  IconUpload,
  IconVault,
} from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { CeremonyRow } from "../CeremonyRow.js";
import { TravelItemsSheet } from "./TravelItemsSheet.js";
import { TravelLeaveSheet } from "./TravelLeaveSheet.js";
import { TravelReturnSheet } from "./TravelReturnSheet.js";
import { plural, travelRefusalText } from "./TravelViews.js";
import { hideableItems } from "./items-text.js";
import { useTravelFlow } from "./useTravelFlow.js";
import { useTravelRemnants } from "./useTravelRemnants.js";
import "../travel.css";

type Sheet = "leave" | "items" | "return" | null;

/** What the receipt row's glyph says; the row's own name is the sentence. */
const RECEIPT_MARK = {
  ok: "Done",
  idle: "Done",
  warn: "Finished with something left",
  err: "Refused",
} as const;

/** A row whose one key opens one of the two ceremonies. */
function ModeRow({
  icon,
  label,
  sub,
  keyLabel,
  disabled,
  onOpen,
}: {
  icon: ReactNode;
  label: string;
  sub: string;
  keyLabel: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <CeremonyRow
      icon={icon}
      label={label}
      sub={sub}
      action={
        <IconKey
          small
          label={keyLabel}
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={onOpen}
        >
          {icon}
        </IconKey>
      }
    />
  );
}

/** Files a cut-short departure left with no header: never openable here. */
function RemnantsRow({
  files,
  busy,
  onClear,
}: {
  files: number;
  busy: boolean;
  onClear: () => void;
}) {
  return (
    <CeremonyRow
      icon={<IconTrash size={16} />}
      label="Leftovers of a departure"
      sub={plural(files, "file")}
      action={
        <IconKey
          small
          label="Clear leftover files"
          disabled={busy}
          onClick={onClear}
        >
          <IconTrash size={16} />
        </IconKey>
      }
    />
  );
}

/** The ceremonies this panel can open, each drawn only where it can act. */
function ModeRows({
  owner,
  busy,
  carried,
  canLeave,
  hideable,
  onOpen,
}: {
  owner: boolean;
  busy: boolean;
  carried: number;
  canLeave: boolean;
  hideable: number;
  onOpen: (sheet: Exclude<Sheet, null>) => void;
}) {
  const blocked = travelRefusalText("owner_not_present");
  return (
    <>
      {canLeave ? (
        <ModeRow
          icon={<IconUpload size={16} />}
          label="Leave for a trip"
          sub={owner ? `${plural(carried, "vault")} on this device` : blocked}
          keyLabel="Turn on travel mode"
          disabled={!owner || busy}
          onOpen={() => onOpen("leave")}
        />
      ) : null}
      {hideable > 0 ? (
        <ModeRow
          icon={<IconVault size={16} />}
          label="Leave items at home"
          sub={owner ? plural(hideable, "item") : blocked}
          keyLabel="Choose items to leave at home"
          disabled={!owner || busy}
          onOpen={() => onOpen("items")}
        />
      ) : null}
      <ModeRow
        icon={<IconDownload size={16} />}
        label="Come home from a trip"
        sub={owner ? "Needs the bundle and its return code" : blocked}
        keyLabel="Turn off travel mode"
        disabled={!owner || busy}
        onOpen={() => onOpen("return")}
      />
    </>
  );
}

export function TravelPanel() {
  const [sheet, setSheet] = useState<Sheet>(null);
  const flow = useTravelFlow(() => setSheet(null));
  const { owner, busy, notice } = flow;
  const { remnants, reread } = useTravelRemnants(owner, notice);
  const sealed = useDeviceVaults().filter(
    (vault) => vault.kind !== "guest" && vault.state !== "empty",
  );
  const carried = sealed.length;
  // The open vault always travels, so leaving needs another to leave behind:
  // with none, packing refuses ("nothing would leave") and the key is a dead
  // end — it is not drawn (ADR 0158).
  const canLeave = sealed.some((vault) => vault.state !== "open");
  const hideable = hideableItems(useVault().items).length;
  const files = remnants.reduce((sum, r) => sum + r.files.length, 0);

  const open = (next: Exclude<Sheet, null>) => {
    flow.reset();
    if (next === "return") flow.startReturn();
    if (next === "items") flow.setMode({ kind: "items" });
    setSheet(next);
  };
  const close = () => {
    // A departure or a return in flight is not cancelled by a key press: its
    // result would land on a panel with no sheet to show it.
    if (busy) return;
    flow.reset();
    setSheet(null);
  };

  return (
    <section
      className="panel set__security"
      id="travel"
      aria-labelledby="travel-title"
    >
      <div className="panel__head">
        <div>
          <h2 id="travel-title">Travel</h2>
        </div>
      </div>
      <div className="panel__body">
        {notice && sheet === null ? (
          <CeremonyRow
            icon={<IconVault size={16} />}
            label={notice.text}
            mark={{ tone: notice.tone, label: RECEIPT_MARK[notice.tone] }}
            sub={notice.meta ?? ""}
            alert={notice.tone === "err"}
            action={null}
          />
        ) : null}
        <ModeRows
          owner={owner}
          busy={busy}
          carried={carried}
          canLeave={canLeave}
          hideable={hideable}
          onOpen={open}
        />
        {owner && remnants.length > 0 ? (
          <RemnantsRow
            files={files}
            busy={busy}
            onClear={() => flow.clearRemnants(reread)}
          />
        ) : null}
      </div>
      {sheet === "leave" ? (
        <TravelLeaveSheet flow={flow} onClose={close} />
      ) : null}
      {sheet === "items" ? (
        <TravelItemsSheet flow={flow} onClose={close} />
      ) : null}
      {sheet === "return" ? (
        <TravelReturnSheet flow={flow} onClose={close} />
      ) : null}
    </section>
  );
}
