import { overlapCast } from "@opensesame/os-domain";
import { type FormEvent, useId, useState } from "react";
import { IconPlus, IconX } from "../../components/Icons.js";
import type {
  Binding,
  BindingTargetKind,
  Connection,
} from "../../lib/connections.js";
import { bindConnection, unbindConnection } from "../../lib/connections.js";
import { grantableAgentId } from "../../lib/identity-graph.js";
import { type Flash, errorText } from "./shared.js";

const BINDING_KINDS: Array<{ value: BindingTargetKind; label: string }> = [
  { value: "identity", label: "Identity" },
  { value: "group", label: "Group" },
  { value: "device", label: "Device" },
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "organization", label: "Organization" },
];

export function BindingEditor({
  connection,
  online,
  onFlash,
  onChanged,
}: {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<BindingTargetKind>("project");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const kindId = useId();
  const targetId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const id = target.trim();
    if (!id) return;
    if (kind === "agent" && !grantableAgentId(id)) {
      onFlash({
        tone: "err",
        text: "Bind an agent, project, or device id — not user:demo.",
      });
      return;
    }
    setBusy(true);
    try {
      await bindConnection(connection.connectionId, {
        targetKind: kind,
        targetId: id,
      });
      setTarget("");
      setAdding(false);
      onFlash({
        tone: "ok",
        text: `${id} can now use ${connection.displayName}.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(binding: Binding) {
    try {
      await unbindConnection(connection.connectionId, binding.id);
      onFlash({
        tone: "ok",
        text: `${binding.targetLabel ?? binding.targetId} can no longer use ${connection.displayName}.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    }
  }

  return (
    <div className="conn-card__block">
      <p className="conn-card__label">Who can use it</p>
      {connection.bindings.length === 0 ? (
        <p className="hint conn-bindings__none">
          Nobody yet. The connection exists, but no project or agent can act
          through it until one is bound.
        </p>
      ) : (
        <ul className="conn-bindings">
          {connection.bindings.map((binding) => (
            <li key={binding.id}>
              <span className="conn-bindings__kind">{binding.targetKind}</span>
              <code>{binding.targetLabel ?? binding.targetId}</code>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Unbind ${binding.targetLabel ?? binding.targetId}`}
                disabled={!online}
                onClick={() => void remove(binding)}
              >
                <IconX size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="conn-bind-form" onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor={kindId}>
              Kind
            </label>
            <select
              id={kindId}
              value={kind}
              onChange={(event) => setKind(overlapCast(event.target.value))}
            >
              {BINDING_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor={targetId}>
              Identifier
            </label>
            <input
              id={targetId}
              value={target}
              placeholder="project_01J… or agent_01J…"
              onChange={(event) => setTarget(event.target.value)}
            />
          </div>
          <div className="actions">
            <button
              type="submit"
              className="btn btn--sm btn--primary"
              disabled={busy || !online || target.trim() === ""}
            >
              {busy ? "Binding…" : "Bind"}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={!online}
          onClick={() => setAdding(true)}
        >
          <IconPlus size={16} />
          Bind an identity
        </button>
      )}
    </div>
  );
}
