import type { ReactNode } from "react";
import { CeremonyRow } from "../CeremonyRow.js";
import { type MethodKind, methodIcon } from "./MethodSheet.js";

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
}: {
  kind: MethodKind;
  label: string;
  state: string;
  on: boolean;
  sub: string;
  action: ReactNode;
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
          ? { tone: on ? "ok" : "idle", label: state }
          : null
      }
      sub={sub}
      action={action}
    />
  );
}
