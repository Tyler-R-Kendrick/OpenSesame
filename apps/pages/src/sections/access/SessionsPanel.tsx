import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAlert,
  IconCheck,
  IconPlus,
  IconRefresh,
} from "../../components/Icons.js";
import {
  type TaskDetail,
  type TaskRun,
  getTask,
  listTasks,
  terminateTask,
} from "../../lib/access.js";
import { useIdentitySession } from "../../lib/identity.js";
import { useHostConfigured } from "../../lib/use-configured.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import {
  type Flash,
  errorText as accessErrorText,
} from "../connections/shared.js";
import { LocalAuthorityPanel } from "./LocalAuthorityPanel.js";
import { NewSession } from "./NewSession.js";
import { TaskCompare, statusTone } from "./TaskCompare.js";
import { Receipts } from "./receipts.js";

function useSessions(online: boolean) {
  const [creating, setCreating] = useState(false);
  const session = useIdentitySession();
  // The task list is the Host's; the receipts trail below it is the Identity
  // API's and renders on its own terms (ADR 0090).
  const hostConfigured = useHostConfigured();
  const [tasks, setTasks] = useState<TaskRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listTasks();
      if (run.current !== id) return;
      setTasks(rows);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setTasks(null);
      setError(accessErrorText(caught));
    }
  }, []);

  useEffect(() => {
    if (!online || !hostConfigured) return;
    void load();
  }, [load, online, hostConfigured]);

  async function terminate(task: TaskRun) {
    setBusyId(task.taskRunId);
    setFlash(null);
    try {
      await terminateTask(task.taskRunId, task.stateVersion);
      setFlash({ tone: "ok", text: `Task ${task.taskRunId} was terminated.` });
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: accessErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  return {
    creating,
    setCreating,
    session,
    hostConfigured,
    tasks,
    error,
    flash,
    busyId,
    load,
    terminate,
  };
}

export function SessionsPanel({ online }: { online: boolean }) {
  const state = useSessions(online);
  const tomb = useVaultStore().activeTomb();
  return (
    <>
      <LocalAuthorityPanel key={tomb} tomb={tomb} />
      {state.hostConfigured ? (
        <SessionList online={online} state={state} />
      ) : null}
      {state.session ? (
        <Receipts online={online} sessionKey={state.session.principalId} />
      ) : null}
    </>
  );
}

function SessionList({
  online,
  state,
}: { online: boolean; state: ReturnType<typeof useSessions> }) {
  const { creating, setCreating, load } = state;
  return (
    <>
      <section className="panel" id="host-sessions">
        <div className="panel__head">
          <div>
            <h2>Host task sessions</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="New session"
            aria-label="New session"
            disabled={!online}
            onClick={() => setCreating(true)}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload sessions"
            aria-label="Reload sessions"
          >
            <IconRefresh />
          </button>
        </div>

        <div className="panel__body">
          {creating ? (
            <NewSession
              online={online}
              onCancel={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                void load();
              }}
            />
          ) : null}
          <SessionRows online={online} state={state} />
        </div>
      </section>
    </>
  );
}

function SessionRows({
  online,
  state,
}: { online: boolean; state: ReturnType<typeof useSessions> }) {
  const { tasks, error, flash, busyId, terminate } = state;
  return (
    <>
      {!online ? (
        <output className="note note--warn">
          <IconAlert /> Offline.
        </output>
      ) : null}

      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}

      {online && tasks === null && !error ? (
        <output className="note">Asking the Host…</output>
      ) : null}

      {tasks && tasks.length > 0 ? (
        <ul className="access-runs">
          {tasks.map((task) => (
            <TaskRow
              key={task.taskRunId}
              task={task}
              online={online}
              busy={busyId === task.taskRunId}
              onTerminate={() => void terminate(task)}
            />
          ))}
        </ul>
      ) : null}

      {tasks && tasks.length === 0 ? (
        <p className="hint">No live sessions.</p>
      ) : null}

      {flash ? (
        <output className={`note note--${flash.tone}`}>
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <p>{flash.text}</p>
        </output>
      ) : null}
    </>
  );
}

function TaskRow({
  task,
  online,
  busy,
  onTerminate,
}: {
  task: TaskRun;
  online: boolean;
  busy: boolean;
  onTerminate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail) return;
    setLoading(true);
    try {
      setDetail(await getTask(task.taskRunId));
      setError(null);
    } catch (caught) {
      setError(accessErrorText(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="access-run">
      <div className="access-run__main">
        <code className="access-run__id">{task.taskRunId}</code>
        <span className={`chip ${statusTone(task.status)}`}>{task.status}</span>
        <span className="access-run__version">v{task.stateVersion}</span>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={open}
            onClick={() => void toggle()}
          >
            {open ? "Hide" : "Inspect"}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy || !online || task.status === "cancelled"}
            onClick={onTerminate}
          >
            {busy ? "Terminating…" : "Terminate"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="access-run__detail">
          {loading ? <output className="note">Asking the Host…</output> : null}
          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
          ) : null}
          {detail ? <TaskCompare detail={detail} /> : null}
        </div>
      ) : null}
    </li>
  );
}
