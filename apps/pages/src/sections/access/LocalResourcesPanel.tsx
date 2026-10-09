import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type ResourceRow,
  loadResourceRows,
  shareSummary,
} from "@opensesame/app-core/sections/access/local-resources-panel-model.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";

export function LocalResourcesPanel() {
  const { tomb } = useVault();
  const selection = useAccessRecord("local-resources", "resources");
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

  const selected = rows.find((row) => row.id === selection.id);
  return (
    <AccessRecords
      title="Local resources"
      selection={selection}
      rows={rows.map((row) => ({
        id: row.id,
        label: row.title,
        extension: row.kind,
        to: selection.path(row.id),
      }))}
    >
      {selected ? (
        <AccessDetail title={selected.title} kind={selected.kind}>
          <AccessFact label="Resource" value={selected.detail} />
          <AccessFact label="Reference" value={selected.id} />
          <AccessFact
            label="Shares"
            value={
              selected.kind === "vault" || selected.kind === "connection"
                ? shareSummary(selected.shares, names)
                : "dogfooded"
            }
          />
        </AccessDetail>
      ) : null}
    </AccessRecords>
  );
}
