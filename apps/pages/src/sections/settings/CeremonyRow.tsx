import type { ReactNode } from "react";
import { StatusMark } from "../../components/StatusMark.js";

/**
 * One row of a Settings list that opens a ceremony: glyph, name, an optional
 * mark for what is set or what cannot be, one line of fact, and exactly one
 * action. A row never holds an input — every form lives in the sheet its
 * action opens (ADR 0091 §8).
 */
export function CeremonyRow({
  icon,
  label,
  mark,
  sub,
  action,
}: {
  icon: ReactNode;
  label: string;
  mark?: { tone: "ok" | "warn" | "err" | "idle"; label: string } | null;
  sub: string;
  action: ReactNode;
}) {
  return (
    <div className="sw sw--method">
      <div>
        <div className="sw__name">
          {icon}
          {label}
          {mark ? <StatusMark tone={mark.tone} label={mark.label} /> : null}
        </div>
        <p className="sw__sub">{sub}</p>
      </div>
      {action}
    </div>
  );
}
