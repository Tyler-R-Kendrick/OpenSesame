import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconDrop, IconX } from "../../components/Icons.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { TtlPicker } from "./DropTtl.js";

/**
 * The key that was pressed unmounts with its own state, so focus follows the
 * ceremony: to the first control when it opens, back to the offer on Cancel.
 * A mount that is already open moves nothing.
 */
export function useShareFocus(open: boolean) {
  const key = useRef<HTMLButtonElement | null>(null);
  const ttlRef = useRef<HTMLSelectElement>(null);
  const next = useRef<"ttl" | "key" | null>(null);
  // The offer's key is also the control a tutorial points at (`item.share`).
  const guideRef = useGuideTarget<HTMLButtonElement>("item.share");
  const keyRef = useCallback(
    (element: HTMLButtonElement | null) => {
      key.current = element;
      guideRef(element);
    },
    [guideRef],
  );

  useEffect(() => {
    const target = next.current;
    next.current = null;
    if (target === "ttl" && open) ttlRef.current?.focus();
    if (target === "key" && !open) key.current?.focus();
  }, [open]);

  return {
    keyRef,
    ttlRef,
    expect(target: "ttl" | "key") {
      next.current = target;
    },
  };
}

/**
 * The closed offer. On a phone the key sits in a headed group like every
 * other action on the page; the stylesheet draws the bar there and nowhere
 * else. The head is decoration (aria-hidden): the key carries the name.
 */
export function ShareOffer({
  keyRef,
  onOpen,
}: {
  keyRef: Ref<HTMLButtonElement>;
  onOpen: () => void;
}) {
  return (
    <section className="detail__group detail__offer">
      <div className="detail__groupbar">
        <span className="detail__grouphead" aria-hidden="true">
          Share once
        </span>
        <IconKey label="Share once" small keyRef={keyRef} onClick={onOpen}>
          <IconDrop size={15} />
        </IconKey>
      </div>
    </section>
  );
}

/** The open ceremony: how long, then seal or cancel. */
export function ShareForm({
  ttlMs,
  onTtl,
  ttlRef,
  notice,
  busy,
  onSeal,
  onCancel,
}: {
  ttlMs: number;
  onTtl: (ms: number) => void;
  ttlRef: Ref<HTMLSelectElement>;
  /** A failure the ceremony reports, drawn between the picker and the keys. */
  notice: ReactNode;
  busy: boolean;
  onSeal: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="detail__group" aria-label="Share this item once">
      <h2 className="detail__grouphead">Share once</h2>
      <TtlPicker value={ttlMs} onChange={onTtl} selectRef={ttlRef} />
      {notice}
      <div className="actions">
        <FormCommit
          label={busy ? "Sealing…" : "Seal and share"}
          disabled={busy}
          busy={busy}
          onClick={onSeal}
          icon={<IconDrop size={18} />}
        />
        <IconKey label="Cancel" small disabled={busy} onClick={onCancel}>
          <IconX size={16} />
        </IconKey>
      </div>
    </section>
  );
}
