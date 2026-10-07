import { useEffect, useRef } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconShare, IconX } from "../../components/Icons.js";
import { TtlChoices } from "./DropTtl.js";

/**
 * The open ceremony: how long, then seal or cancel. It is drawn under the
 * item's fields once the toolbar's Share key is pressed, and takes the focus
 * on the choice in force so the keyboard carries straight on.
 */
export function ShareForm({
  ttlMs,
  onTtl,
  busy,
  onSeal,
  onCancel,
}: {
  ttlMs: number;
  onTtl: (ms: number) => void;
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
      <TtlChoices
        value={ttlMs}
        onChange={onTtl}
        selectedRef={chosen}
        disabled={busy}
      />
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
