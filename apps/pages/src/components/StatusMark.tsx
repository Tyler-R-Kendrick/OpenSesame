/**
 * Status is a glyph. The sentence is `aria-label` and `title`, never a pill.
 * See DESIGN.md § Status is a symbol.
 */
import { IconAlert, IconCheck, IconLock, IconX } from "./Icons.js";

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

export function StatusMark({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) {
  return (
    <span
      className={`status-mark status-mark--${tone}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <MarkIcon tone={tone} size={14} />
    </span>
  );
}
