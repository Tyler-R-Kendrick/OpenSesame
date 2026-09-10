import type { AgentResponse } from "@opensesame/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listManagedAgents,
  registerManagedAgent,
  updateManagedAgent,
} from "../../lib/identity-management.js";

function useAgents() {
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{
    id: string;
    name: string;
    jkt: string;
  } | null>(null);
  const [revoke, setRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const rows = await listManagedAgents();
      if (current === generation.current) setAgents(rows);
    } catch {
      if (current === generation.current) {
        setAgents([]);
        setError("Could not load agents; retry or reconnect to Identity.");
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      if (draft.id)
        await updateManagedAgent(draft.id, { displayName: draft.name.trim() });
      else await registerManagedAgent(draft.name.trim(), draft.jkt.trim());
      setDraft(null);
      await load();
    } catch {
      setError(
        "Could not save the agent; check your session, proof key and registration quota.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function revokeAgent(id: string) {
    setBusy(true);
    setError("");
    try {
      await updateManagedAgent(id, { state: "revoked" });
      setRevoke(null);
      await load();
    } catch {
      setError(
        "Could not revoke the agent; reload and confirm that you still own it.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    agents,
    loading,
    error,
    draft,
    setDraft,
    revoke,
    setRevoke,
    busy,
    load,
    save,
    revokeAgent,
  };
}

export function AgentsPanel({ online }: { online: boolean }) {
  const model = useAgents();
  const { agents, loading, error, setDraft, busy, load } = model;
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Agents</h2>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!online || busy}
            onClick={() => void load()}
          >
            Reload agents
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!online || busy}
            onClick={() => setDraft({ id: "", name: "", jkt: "" })}
          >
            New agent
          </button>
        </div>
      </div>
      <div className="panel__body">
        <p className="hint">
          Register an agent against its own proof key; registration alone grants
          no resource access.
        </p>
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? <output>Loading agents…</output> : null}
        {!loading && !error && agents.length === 0 ? (
          <p className="hint">No agents registered.</p>
        ) : null}
        <AgentsRows model={model} online={online} />
        <AgentsForm model={model} online={online} />
      </div>
    </section>
  );
}

function AgentsForm({
  model,
  online,
}: { model: ReturnType<typeof useAgents>; online: boolean }) {
  const { draft, setDraft, busy, save } = model;
  if (!draft) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label className="label" htmlFor="identity-agent-name">
          Agent name
        </label>
        <input
          id="identity-agent-name"
          required
          maxLength={128}
          disabled={busy}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </div>
      {!draft.id ? (
        <div className="field">
          <label className="label" htmlFor="identity-agent-jkt">
            Agent public-key thumbprint
          </label>
          <input
            id="identity-agent-jkt"
            required
            pattern="[A-Za-z0-9_-]{43}"
            disabled={busy}
            value={draft.jkt}
            onChange={(event) =>
              setDraft({ ...draft, jkt: event.target.value })
            }
            aria-describedby="identity-agent-key-help"
          />
          <p className="hint" id="identity-agent-key-help">
            Paste the SHA-256 JWK thumbprint from the agent runtime, never its
            private key.
          </p>
        </div>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !online || !draft.name.trim()}
        >
          {busy ? "Saving…" : draft.id ? "Save agent" : "Register agent"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setDraft(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function AgentsRows({
  model,
  online,
}: { model: ReturnType<typeof useAgents>; online: boolean }) {
  const { agents, busy, setDraft, revoke, setRevoke, revokeAgent } = model;
  return (
    <ul className="identity-rows">
      {agents.map((agent) => (
        <li className="identity-row" key={agent.id}>
          <div className="identity-row__main">
            <div className="identity-row__id">
              <h3>{agent.displayName}</h3>
              <code className="identity-ref">{agent.id}</code>
            </div>
            <span className="chip">{agent.state}</span>
            {agent.state !== "revoked" ? (
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy || !online}
                  onClick={() =>
                    setDraft({
                      id: agent.id,
                      name: agent.displayName,
                      jkt: "",
                    })
                  }
                  aria-label={`Edit ${agent.displayName}`}
                >
                  Edit
                </button>
                {revoke === agent.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busy || !online}
                      onClick={() => void revokeAgent(agent.id)}
                    >
                      Confirm revocation
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() => setRevoke(null)}
                    >
                      Keep agent
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy || !online}
                    onClick={() => setRevoke(agent.id)}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
