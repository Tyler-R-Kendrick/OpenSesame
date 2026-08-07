export interface TaskCapability {
  action: string;
  resource: string;
}

export interface TaskAccessViewModel {
  taskRunId: string;
  stateVersion: number;
  status: string;
  ceiling: TaskCapability[];
  current: TaskCapability[];
}

function normalizeCapabilities(raw: unknown): TaskCapability[] {
  if (typeof raw === "object" && raw !== null && "capabilities" in raw) {
    return normalizeCapabilities((raw as { capabilities: unknown }).capabilities);
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }
      const rec = item as Record<string, unknown>;
      const action = String(rec.action ?? "");
      let resource = "";
      if (typeof rec.resource === "string") {
        resource = rec.resource;
      } else if (typeof rec.resource === "object" && rec.resource !== null) {
        const sel = rec.resource as Record<string, unknown>;
        resource = String(sel.value ?? sel.pattern ?? "");
      }
      if (!action || !resource) {
        return null;
      }
      return { action, resource };
    })
    .filter((x): x is TaskCapability => x !== null);
}

export function buildTaskAccessViewModel(body: Record<string, unknown>): TaskAccessViewModel {
  return {
    taskRunId: String(body.task_run_id ?? ""),
    stateVersion: Number(body.state_version ?? 0),
    status: String(body.status ?? "unknown"),
    ceiling: normalizeCapabilities(body.capability_ceiling),
    current: normalizeCapabilities(body.current_capabilities),
  };
}

interface TaskAccessPanelProps {
  model: TaskAccessViewModel;
}

export function TaskAccessPanel({ model }: TaskAccessPanelProps) {
  const rows = mergeCapabilityRows(model.ceiling, model.current);

  return (
    <section className="panel" aria-labelledby="task-access-heading">
      <h2 id="task-access-heading">Task access (trust ratchet)</h2>
      <dl className="meta-grid">
        <div>
          <dt>Task ID</dt>
          <dd>{model.taskRunId || "—"}</dd>
        </div>
        <div>
          <dt>State version</dt>
          <dd>{model.stateVersion}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{model.status}</dd>
        </div>
      </dl>

      <p className="warn-banner" role="note">
        This active task cannot be widened. Create a new task with reviewed authority.
      </p>

      <div className="cap-table-wrap">
        <table className="cap-table" aria-label="Ceiling versus current capabilities">
          <thead>
            <tr>
              <th scope="col">Ceiling</th>
              <th scope="col">Current</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={2}>No capabilities recorded.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.ceiling ?? "—"}</td>
                  <td>{row.current ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function mergeCapabilityRows(ceiling: TaskCapability[], current: TaskCapability[]) {
  const keys = new Set<string>();
  const ceilingMap = new Map<string, string>();
  const currentMap = new Map<string, string>();

  for (const cap of ceiling) {
    const key = `${cap.action}@${cap.resource}`;
    keys.add(key);
    ceilingMap.set(key, formatCap(cap));
  }
  for (const cap of current) {
    const key = `${cap.action}@${cap.resource}`;
    keys.add(key);
    currentMap.set(key, formatCap(cap));
  }

  return [...keys].sort().map((key) => ({
    key,
    ceiling: ceilingMap.get(key),
    current: currentMap.get(key),
  }));
}

function formatCap(cap: TaskCapability): string {
  return `${cap.action} → ${cap.resource}`;
}
