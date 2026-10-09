import type { ReactNode } from "react";

/** The same ruled facts used by a vault item. */
export function IdentityFact({
  label,
  children,
}: { label: string; children: ReactNode }) {
  return (
    <div className="frow">
      <div className="frow__text">
        <span className="frow__label">{label}</span>
        <span className="frow__value">{children}</span>
      </div>
    </div>
  );
}
