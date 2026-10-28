/** What the Routes Form's sections share (ADR 0150 §6). */

import type { CarrierKind } from "@opensesame/app-core/lib/live/transport.js";
import { useLayoutEffect, useRef, useState } from "react";
import { IconTrash } from "../../components/Icons.js";
import type { Edit } from "./live-transport-hooks.js";

/** Admit one save at a time while keeping its fields editable. */
export function useRouteSaveGuard() {
  const active = useRef(false);
  const [state, setState] = useState({ pending: false, generation: 0 });
  // Release only after the completion and its field resets are committed.
  // The generation forces a commit even if the write settles in the same tick.
  useLayoutEffect(() => {
    if (!state.pending) active.current = false;
  }, [state]);
  return {
    pending: state.pending,
    begin: () => {
      if (active.current) return false;
      active.current = true;
      setState((now) => ({ ...now, pending: true }));
      return true;
    },
    finish: () =>
      setState((now) => ({ pending: false, generation: now.generation + 1 })),
  };
}

/** Apply an edit; the refusal it meets, or null once written. */
export type Change = (edit: Edit) => Promise<string | null>;

export const KIND_LABELS = {
  nostr: "Nostr relay",
  mqtt: "MQTT broker",
  nats: "NATS server",
  ntfy: "ntfy server",
  broadcast: "This browser's tabs",
} satisfies Record<CarrierKind, string>;

export function RemoveKey({
  label,
  onRemove,
}: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={onRemove}
    >
      <IconTrash size={16} />
    </button>
  );
}
