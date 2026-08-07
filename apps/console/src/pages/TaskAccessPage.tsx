import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  TaskAccessPanel,
  buildTaskAccessViewModel,
  type TaskAccessViewModel,
} from "../components/TaskAccessPanel.js";

const gateway =
  import.meta.env.VITE_OPENSESAME_GATEWAY ?? "http://127.0.0.1:8787";

export function TaskAccessPage() {
  const [params] = useSearchParams();
  const taskId = params.get("task") ?? "";
  const [model, setModel] = useState<TaskAccessViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setModel(null);
      setError("Provide ?task=<task_run_id> to inspect task access.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${gateway.replace(/\/$/, "")}/api/v1/tasks/${encodeURIComponent(taskId)}`);
        if (!res.ok) {
          throw new Error(`Host API ${res.status}`);
        }
        const body = (await res.json()) as Record<string, unknown>;
        if (!cancelled) {
          setModel(buildTaskAccessViewModel(body));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setModel(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <div>
      <h1>Task access</h1>
      <p className="lede">Immutable ceiling vs current held capabilities.</p>
      {error ? <p className="warn-banner">{error}</p> : null}
      {model ? <TaskAccessPanel model={model} /> : null}
    </div>
  );
}
