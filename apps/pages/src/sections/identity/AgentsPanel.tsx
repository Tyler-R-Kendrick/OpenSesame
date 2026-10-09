import {
  listManagedAgents,
  registerManagedAgent,
  updateManagedAgent,
} from "@opensesame/app-core/lib/identity-management.js";
import type { AgentResponse } from "@opensesame/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  HostedDetailHead,
  HostedFact,
  useHostedRecord,
} from "./HostedRecordParts.js";
import { usePublishHostedIdentityRows } from "./hosted-identity-rail.js";

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

  async function save(afterCommit?: (id: string) => void) {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const saved = draft.id
        ? await updateManagedAgent(draft.id, { displayName: draft.name.trim() })
        : await registerManagedAgent(draft.name.trim(), draft.jkt.trim());
      setDraft(null);
      afterCommit?.(saved.id);
      await load();
      return saved.id;
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
  const route = useHostedRecord("agents");
  const { agents, loading, error, setDraft, busy, load, draft } = model;
  const railRows = useMemo(
    () => agents.map((row) => ({ id: row.id, label: row.displayName })),
    [agents],
  );
  usePublishHostedIdentityRows("agents", railRows);
  const selected = agents.find((agent) => agent.id === route.selectedId);
  useEffect(() => {
    if (route.creating) setDraft({ id: "", name: "", jkt: "" });
    else if (route.editing && selected && selected.state !== "revoked")
      setDraft({ id: selected.id, name: selected.displayName, jkt: "" });
    else setDraft(null);
  }, [route.creating, route.editing, selected, setDraft]);
  return (
    <RecordWorkspace
      section="Identity"
      title="Agents"
      rootPath="/identity"
      listPath={route.listPath}
      rows={agents.map((agent) => ({
        id: agent.id,
        label: agent.displayName,
        extension: "agent",
        to: `${route.listPath}#${encodeURIComponent(agent.id)}`,
      }))}
      selectedId={route.selectedId}
      detailOpen={route.creating || Boolean(selected)}
      status={
        <>
          <FailureNotice id="identity:agents" title="Agents" message={error} />
          {loading ? <output>Loading agents…</output> : null}
        </>
      }
      commands={
        <>
          <IconKey
            label="New agent"
            small
            disabled={!online || busy}
            onClick={route.create}
          >
            <IconPlus size={15} />
          </IconKey>
          <IconKey
            label="Reload agents"
            small
            disabled={!online || busy}
            onClick={() => void load()}
          >
            <IconRefresh size={15} />
          </IconKey>
        </>
      }
    >
      {draft ? (
        <>
          <HostedDetailHead
            title={draft.id ? `Edit ${draft.name}` : "New agent"}
          />
          <AgentsForm
            model={model}
            online={online}
            onCancel={route.close}
            onSaved={(id) => route.open(id)}
          />
        </>
      ) : selected ? (
        <AgentDetail
          selected={selected}
          model={model}
          route={route}
          online={online}
        />
      ) : null}
    </RecordWorkspace>
  );
}

function AgentsForm({
  model,
  online,
  onCancel,
  onSaved,
}: {
  model: ReturnType<typeof useAgents>;
  online: boolean;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { draft, setDraft, busy, save } = model;
  if (!draft) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(onSaved);
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
            title="Paste the SHA-256 JWK thumbprint from the agent runtime, never its private key"
          />
        </div>
      ) : null}
      <FormCommit
        label="Save agent"
        disabled={busy || !online || !draft.name.trim()}
      >
        <IconKey label="Cancel" disabled={busy} onClick={onCancel}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  );
}

function AgentDetail({
  selected,
  model,
  route,
  online,
}: {
  selected: AgentResponse;
  model: ReturnType<typeof useAgents>;
  route: ReturnType<typeof useHostedRecord>;
  online: boolean;
}) {
  const { busy } = model;
  return (
    <>
      <HostedDetailHead
        title={selected.displayName}
        tools={
          selected.state !== "revoked" ? (
            <>
              <IconKey
                label={`Edit ${selected.displayName}`}
                disabled={busy || !online}
                onClick={() => route.edit(selected.id)}
              >
                <IconEdit size={16} />
              </IconKey>
              <IconKey
                label={
                  model.revoke === selected.id ? "Confirm revocation" : "Revoke"
                }
                disabled={busy || !online}
                onClick={() => {
                  if (model.revoke === selected.id)
                    void model.revokeAgent(selected.id);
                  else model.setRevoke(selected.id);
                }}
              >
                <IconTrash size={16} />
              </IconKey>
              {model.revoke === selected.id ? (
                <IconKey
                  label="Keep agent"
                  disabled={busy}
                  onClick={() => model.setRevoke(null)}
                >
                  <IconX size={16} />
                </IconKey>
              ) : null}
            </>
          ) : null
        }
      />
      <HostedFact label="Agent ID">{selected.id}</HostedFact>
      <HostedFact label="State">
        <StatusMark
          tone={
            selected.state === "revoked"
              ? "err"
              : selected.state === "suspended"
                ? "warn"
                : selected.state === "claimed"
                  ? "ok"
                  : "idle"
          }
          label={selected.state}
        />
      </HostedFact>
      <HostedFact label="Provider">{selected.provider || "Not set"}</HostedFact>
      <HostedFact label="Created">{selected.createdAt}</HostedFact>
    </>
  );
}
