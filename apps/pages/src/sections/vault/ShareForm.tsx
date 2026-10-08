import { isDeviceIdentityMode } from "@opensesame/app-core/lib/device-identity.js";
import { useEffect, useRef } from "react";
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
  const chosen = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    chosen.current?.focus();
  }, []);
  return (
    <section className="detail__group" aria-label="Share this item once">
      <h2 className="detail__grouphead">Share once</h2>
      {isDeviceIdentityMode() ? (
        <FieldRow label="Opens on">
          <span className="frow__value">This browser</span>
        </FieldRow>
      ) : null}
      <TtlChoices
        value={ttlMs}
        onChange={onTtl}
        selectedRef={chosen}
        disabled={busy}
      />
      <FieldRow label="Expires">
        <span className="frow__value">{expiry}</span>
      </FieldRow>
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
