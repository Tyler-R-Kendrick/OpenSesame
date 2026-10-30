import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { useEffect, useRef } from "react";

/**
 * Drops sealed here travel: the link carries the sealed packet, so any browser
 * opens it (P8-1). Shown before seal only where that is true — a configured
 * Identity API already claims cross-device and draws no row.
 */
export function showPortableDropScope(): boolean {
  return deviceIdentitySeams.remoteIdentityApi() === "";
}
import { FieldRow } from "../../components/FieldRow.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconShare, IconX } from "../../components/Icons.js";
import { TtlChoices } from "./DropTtl.js";

/**
 * The open ceremony: how long, the time that choice lapses, then seal or
 * cancel. It is drawn under the item's fields once the toolbar's Share key
 * is pressed, and takes the focus on the choice in force so the keyboard
 * carries straight on.
 */
export function ShareForm({
  ttlMs,
  onTtl,
  expiry,
  busy,
  onSeal,
  onCancel,
}: {
  ttlMs: number;
  onTtl: (ms: number) => void;
  /** When the choice in force lapses, as a fact — the same row the card keeps. */
  expiry: string;
  busy: boolean;
  onSeal: () => void;
  onCancel: () => void;
}) {
  const portable = showPortableDropScope();
  const chosen = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    chosen.current?.focus();
  }, []);
  return (
    <section
      className="detail__group"
      aria-label={portable ? "Share a copy" : "Share this item once"}
    >
      <h2 className="detail__grouphead">
        {portable ? "Share a copy" : "Share once"}
      </h2>
      {portable ? (
        <FieldRow label="Opens on">
          <span className="frow__value">
            Any browser with the link and code
          </span>
        </FieldRow>
      ) : null}
      <TtlChoices
        value={ttlMs}
        onChange={onTtl}
        selectedRef={chosen}
        disabled={busy}
        label={portable ? "Suggested window" : "Opens for"}
      />
      <FieldRow label={portable ? "Suggested expiry" : "Expires"}>
        <span className="frow__value">{expiry}</span>
      </FieldRow>
      {portable ? (
        <p className="hint">
          A saved link and code can reopen this copy after that time. It cannot
          be revoked.
        </p>
      ) : null}
      <div className="actions">
        <FormCommit
          label={busy ? "Sealing…" : "Seal and share"}
          disabled={busy}
          busy={busy}
          onClick={onSeal}
          icon={<IconShare size={18} />}
        />
        <IconKey label="Cancel" small disabled={busy} onClick={onCancel}>
          <IconX size={16} />
        </IconKey>
      </div>
    </section>
  );
}
