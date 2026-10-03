/** What the Routes Form's sections share (ADR 0150 §6). */

import type { CarrierKind } from "@opensesame/app-core/lib/live/transport.js";
import { IconTrash } from "../../components/Icons.js";
import type { Edit } from "./live-transport-hooks.js";

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
