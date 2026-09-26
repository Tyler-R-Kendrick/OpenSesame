import type { ReactNode } from "react";
import { StatusMark } from "../../../components/StatusMark.js";
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
    <div className="sw sw--method">
      <div>
        <div className="sw__name">
          {methodIcon(kind)}
          {label}
          {/* A mark for what is set or what cannot be; "off" is the row's
              + key already. The idle glyph is a lock, so an off PIN drew a
              lock badge beside its own lock icon. */}
          {on || state !== "Off" ? (
            <StatusMark tone={on ? "ok" : "idle"} label={state} />
          ) : null}
        </div>
        <p className="sw__sub">{sub}</p>
      </div>
      {action}
    </div>
  );
}
