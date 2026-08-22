import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  TaskAccessPanel,
  type TaskAccessViewModel,
  buildTaskAccessViewModel,
} from "../components/TaskAccessPanel.js";
import { operatorHeadersFor } from "../lib/urls.js";

const gateway =
  import.meta.env.VITE_OPENSESAME_GATEWAY ?? "http://127.0.0.1:8787";
/** Local/dev operator bearer — never bake production secrets into the console build. */
const operatorToken =
  import.meta.env.VITE_OPENSESAME_OPERATOR_TOKEN?.trim() ?? "";

export function TaskAccessPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const taskId = params.get("task") ?? "";
  const [draftId, setDraftId] = useState(taskId);
  const [model, setModel] = useState<TaskAccessViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraftId(taskId);
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setModel(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const base = gateway.replace(/\/$/, "");
        // A build pointed at a remote gateway does not get to carry this secret,
        // whatever the build-time variable happened to hold.
        const headers = operatorHeadersFor(base, operatorToken);
        const res = await fetch(
          `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`,
          { headers },
        );
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error("No task found for that id.");
          }
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              "Host API denied this request. Sign in or pass an operator session.",
            );
          }
          throw new Error(`Host API could not load this task (${res.status}).`);
        }
        const body = overlapCast(await res.json());
        if (!cancelled) {
          setModel(buildTaskAccessViewModel(body));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setModel(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  function onInspect(e: FormEvent) {
    e.preventDefault();
    const next = draftId.trim();
    if (!next) {
      setError("Enter a task run id to inspect.");
      return;
    }
    navigate(`/task-access?task=${encodeURIComponent(next)}`);
  }

  return (
    <section className="panel">
      <h1>Task access</h1>
      <p>
        Compare the immutable capability ceiling with what the task currently
        holds. Authority only narrows; widening requires a new task.
      </p>
      <form onSubmit={onInspect}>
        <div className="field">
          <label htmlFor="task-run-id">Task run id</label>
          <input
            id="task-run-id"
            name="task"
            placeholder="taskrun_…"
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? "Loading…" : "Inspect task"}
          </button>
        </div>
      </form>
      {!taskId ? (
        <output className="empty-hint">
          Enter a task run id, or open this page with{" "}
          <code>?task=&lt;task_run_id&gt;</code>.
        </output>
      ) : null}
      {loading && taskId ? (
        <output className="lede" aria-busy="true">
          Loading task from Host API…
        </output>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {model ? <TaskAccessPanel model={model} /> : null}
    </section>
  );
}
