/**
 * Status is a glyph. The sentence is `aria-label` and `title`, never a pill.
 * See DESIGN.md § Status is a symbol.
 *
 * A finger has no hover, so the `title` has a touch twin (`status-twin.ts`):
 * a tap or a long press shows the same sentence in a transient bubble. The
 * bubble is `aria-hidden` — the accessible name already says it.
 */
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconCheck, IconLock, IconX } from "./Icons.js";
import { placeBubble, useStatusTwin } from "./status-twin.js";
import "./status-mark.css";

export type StatusTone = "ok" | "warn" | "err" | "idle";

export function statusTone(tone: string): StatusTone {
  if (tone.includes("ok") || tone === "live") return "ok";
  if (tone.includes("warn") || tone === "attn") return "warn";
  if (tone.includes("err") || tone === "down") return "err";
  return "idle";
}

function MarkIcon({ tone, size }: { tone: StatusTone; size: number }) {
  if (tone === "ok") return <IconCheck size={size} />;
  if (tone === "warn") return <IconAlert size={size} />;
  if (tone === "err") return <IconX size={size} />;
  return <IconLock size={size} />;
}

/** The sentence, drawn beside its mark. Placed once it can be measured. */
function StatusBubble({
  anchor,
  label,
}: {
  anchor: HTMLElement;
  label: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const bubble = ref.current;
    if (!bubble) return;
    const { left, top } = placeBubble(
      anchor.getBoundingClientRect(),
      bubble.getBoundingClientRect(),
      { width: document.documentElement.clientWidth },
    );
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.dataset.placed = "";
  }, [anchor]);
  return createPortal(
    <span ref={ref} className="status-bubble" aria-hidden="true">
      {label}
    </span>,
    document.body,
  );
}

export function StatusMark({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { open, tappable } = useStatusTwin(ref);
  return (
    <span
      ref={ref}
      className={`status-mark status-mark--${tone}`}
      role="img"
      aria-label={label}
      title={label}
      data-touch-twin={tappable ? "" : undefined}
    >
      <MarkIcon tone={tone} size={14} />
      {open && ref.current ? (
        <StatusBubble anchor={ref.current} label={label} />
      ) : null}
    </span>
  );
}
