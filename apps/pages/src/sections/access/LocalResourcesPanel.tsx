import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type ResourceRow,
  loadResourceRows,
  shareSummary,
} from "@opensesame/app-core/sections/access/local-resources-panel-model.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";

function ResourceList({
  rows,
  names,
}: {
  rows: ResourceRow[];
  names: Map<string, string>;
}) {
  if (rows.length === 0) {
    return <p className="hint">Unlock a vault to see local resources.</p>;
  }
  return (
    <ul className="access-resources">
      {rows.map((row) => (
        <li className="access-resource" key={row.id}>
          <div className="access-resource__main">
            <div className="access-resource__id">
              <h3>{row.title}</h3>
              <code className="access-ref">
                {row.kind} · {row.detail}
              </code>
            </div>
            <span className="access-resource__meta">
              {row.kind === "vault" || row.kind === "connection"
                ? shareSummary(row.shares, names)
                : "dogfooded"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LocalResourcesPanel() {
  const { tomb } = useVault();
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void loadResourceRows(tomb)
        .then((next) => {
          if (!alive) return;
          setNames(next.names);
          setRows(next.rows);
        })
        .catch(() => {
          if (alive) setRows([]);
        });
    };
    const off = subscribeLocalIamChanges(reload);
    reload();
    return () => {
      alive = false;
      off();
    };
  }, [tomb]);

  return (
    <section
      className="panel"
      id="local-resources"
      aria-label="Local resources"
    >
      <div className="panel__head">
        <h2>Local resources</h2>
      </div>
      <div className="panel__body">
        <ResourceList rows={rows} names={names} />
      </div>
    </section>
  );
}
