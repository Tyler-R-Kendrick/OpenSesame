/** One visual shell for every connector's configuration and completion step. */
import type { ReactNode } from "react";

export function ConnectorPanel({
  id = "connector",
  label = "Connector",
  step,
  title,
  actions,
  focus = false,
  children,
}: {
  id?: string;
  label?: string;
  step: number;
  title: string;
  actions?: ReactNode;
  focus?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="panel"
      id={id}
      aria-label={label}
      tabIndex={focus ? -1 : undefined}
    >
      <div className="panel__head">
        <h2>
          <span className="cx-step">{step}</span> {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
