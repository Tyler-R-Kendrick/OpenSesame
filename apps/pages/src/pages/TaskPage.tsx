import { type FormEvent, useState } from "react";
import { type DemoTask, createDemoTask } from "../lib/demo-task.js";
import { loadSettings } from "../lib/settings.js";
import { operatorHeadersFor } from "../lib/urls.js";

type TaskView = {
  task_run_id: string;
  state_version: number;
  status: string;
  synthetic?: boolean;
  note?: string;
  capability_ceiling: { action: string; resource: string }[];
  current_capabilities: { action: string; resource: string }[];
};

function formatCap(cap?: { action: string; resource: string }): string {
  return cap ? `${cap.action} → ${cap.resource}` : "—";
}

function normalize(
  body: Record<string, unknown>,
  synthetic?: boolean,
): TaskView {
  const ceiling = (body.capability_ceiling ??
    []) as TaskView["capability_ceiling"];
  const current = (body.current_capabilities ??
    body.capabilities ??
    []) as TaskView["current_capabilities"];
  return {
    task_run_id: String(body.task_run_id ?? ""),
    state_version: Number(body.state_version ?? 0),
    status: String(body.status ?? "unknown"),
    synthetic,
    note: typeof body.note === "string" ? body.note : undefined,
    capability_ceiling: Array.isArray(ceiling) ? ceiling : [],
    current_capabilities: Array.isArray(current) ? current : [],
  };
}

export function TaskPage({ online }: { online: boolean }) {
  const [taskId, setTaskId] = useState("");
  const [model, setModel] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function inspect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setModel(null);
    const id = taskId.trim();
    if (!id) {
      setError("Enter a task run id, or load the offline demo.");
      return;
    }
    if (!online) {
      setError(
        "Host API unreachable offline. Load the synthetic demo instead.",
      );
      return;
    }
    setBusy(true);
    try {
      const { hostApi, operatorToken } = loadSettings();
      const base = hostApi.replace(/\/$/, "");
      // The operator token belongs to this machine; a remote Host API gets nothing.
      const headers = operatorHeadersFor(base, operatorToken);
      const res = await fetch(
        `${base}/api/v1/tasks/${encodeURIComponent(id)}`,
        {
          headers,
        },
      );
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "No task found for that id."
            : `Host API could not load this task (${res.status}).`,
        );
      }
      const body = (await res.json()) as Record<string, unknown>;
      setModel(normalize(body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function loadDemo() {
    const demo: DemoTask = createDemoTask();
    setError(null);
    setModel(normalize(demo as unknown as Record<string, unknown>, true));
  }

  return (
    <section className="panel">
      <h1>Task access</h1>
      <p>
        Immutable ceiling versus current held capabilities. Authority only
        narrows; widening requires a new task.
      </p>
      <form onSubmit={inspect}>
        <label htmlFor="task-id">Task run id</label>
        <input
          id="task-id"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          placeholder="taskrun_…"
          spellCheck={false}
          disabled={busy}
        />
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={busy || !online}
            aria-busy={busy}
          >
            {busy ? "Loading…" : "Inspect live task"}
          </button>
          <button type="button" onClick={loadDemo}>
            Load offline demo
          </button>
        </div>
      </form>
      {model?.synthetic ? (
        <p className="warn" role="status">
          Synthetic demo data — not live Host authority. {model.note}
        </p>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {model ? (
        <>
          <ul className="status-list">
            <li>
              <span className="k">Task</span>
              <span className="v">{model.task_run_id}</span>
            </li>
            <li>
              <span className="k">State version</span>
              <span className="v">{model.state_version}</span>
            </li>
            <li>
              <span className="k">Status</span>
              <span className="v">{model.status}</span>
            </li>
          </ul>
          <div style={{ overflowX: "auto" }}>
            <table
              className="cap-table"
              aria-label="Capability ceiling versus current"
            >
              <thead>
                <tr>
                  <th>Ceiling</th>
                  <th>Current</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({
                  length: Math.max(
                    model.capability_ceiling.length,
                    model.current_capabilities.length,
                    1,
                  ),
                }).map((_, i) => (
                  <tr key={i}>
                    <td>{formatCap(model.capability_ceiling[i])}</td>
                    <td>{formatCap(model.current_capabilities[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            This active task cannot be widened. Create a new task for broader
            authority.
          </p>
        </>
      ) : null}
    </section>
  );
}
