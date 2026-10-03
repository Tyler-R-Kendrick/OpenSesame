import type { ReactNode } from "react";
import type { StatusTone } from "../../../components/StatusMark.js";
import { CeremonyRow } from "../CeremonyRow.js";
import { type RowKind, methodIcon } from "./MethodSheet.js";

/**
 * One row of Settings › Security: glyph, name, state chip, one line, one
 * action. Never an input — every form is in the one sheet (ADR 0091 §8).
 */
export function MethodRow({
  kind,
  label,
  state,
  on,
  sub,
  action,
  tone,
}: {
  kind: RowKind;
  label: string;
  state: string;
  on: boolean;
  sub: string;
  action: ReactNode;
  /** Overrides the mark's tone, for a state that is neither on nor off. */
  tone?: StatusTone;
}) {
  return (
    <CeremonyRow
      icon={methodIcon(kind)}
      label={label}
      // A mark for what is set or what cannot be; "off" is the row's + key
      // already. The idle glyph is a lock, so an off PIN drew a lock badge
      // beside its own lock icon.
      mark={
        on || state !== "Off"
          ? { tone: tone ?? (on ? "ok" : "idle"), label: state }
          : null
      }
      sub={sub}
      action={action}
    />
  );
}
