import { overlapCast } from "@opensesame/os-domain";
import { type FormEvent, useEffect, useState } from "react";
import type { Connection } from "../../lib/connections.js";
import { updateConnectionPolicy } from "../../lib/connections.js";
import { type Flash, errorText } from "./shared.js";

export function PolicyEditor({
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
  const [shareability, setShareability] = useState(connection.shareability);
  const [maxInvokeLevel, setMaxInvokeLevel] = useState<1 | 2>(
    connection.maxInvokeLevel === 1 ? 1 : 2,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setShareability(connection.shareability);
    setMaxInvokeLevel(connection.maxInvokeLevel === 1 ? 1 : 2);
  }, [connection]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await updateConnectionPolicy(connection.connectionId, {
        shareability,
        maxInvokeLevel,
      });
      onFlash({ tone: "ok", text: "Connector rules saved." });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="conn-policy" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="connector-shareability">
          Delegation
        </label>
        <select
          id="connector-shareability"
          value={shareability}
          onChange={(event) => setShareability(overlapCast(event.target.value))}
        >
          <option value="private">Private to its owner</option>
          <option value="delegable">May be delegated through bindings</option>
          <option value="organization_wide">Available organization-wide</option>
        </select>
        <p className="hint">
          Bindings above still identify the groups, devices, identities, and
          workloads this authorization is intended for.
        </p>
      </div>
      <div className="field">
        <label className="label" htmlFor="connector-invoke-level">
          Maximum action
        </label>
        <select
          id="connector-invoke-level"
          value={maxInvokeLevel}
          onChange={(event) =>
            setMaxInvokeLevel(event.target.value === "1" ? 1 : 2)
          }
        >
          <option value={1}>Typed connector operations only</option>
          <option value={2}>Constrained provider requests</option>
        </select>
        <p className="hint">
          Credentials are never returned to a user, device, project, or agent.
        </p>
      </div>
      <dl className="conn-policy__facts">
        <div>
          <dt>Provider scope</dt>
          <dd>
            {connection.grantedScopes.length > 0
              ? connection.grantedScopes.join(", ")
              : "No delegated provider scopes"}
          </dd>
        </div>
        <div>
          <dt>Outbound boundary</dt>
          <dd>
            {connection.egress.authorities.length > 0
              ? `${connection.egress.scheme}://${connection.egress.authorities.join(", ")}`
              : "No outbound provider host"}
          </dd>
        </div>
      </dl>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={busy || !online}
      >
        {busy ? "Saving…" : "Save rules"}
      </button>
    </form>
  );
}
