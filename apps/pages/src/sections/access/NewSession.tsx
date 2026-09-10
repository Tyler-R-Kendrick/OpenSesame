import { useState } from "react";
import { createAccessSession } from "../../lib/access-sessions.js";

function useNewSession(onCreated: () => void) {
  const [action, setAction] = useState("");
  const [resource, setResource] = useState("");
  const [ttl, setTtl] = useState("900");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await createAccessSession(
        [{ action: action.trim(), resource: resource.trim() }],
        Number(ttl),
      );
      onCreated();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Session not started; reconnect and retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    action,
    setAction,
    resource,
    setResource,
    ttl,
    setTtl,
    busy,
    error,
    submit,
  };
}

export function NewSession({
  online,
  onCreated,
  onCancel,
}: {
  online: boolean;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const {
    action,
    setAction,
    resource,
    setResource,
    ttl,
    setTtl,
    busy,
    error,
    submit,
  } = useNewSession(onCreated);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>Start a scoped session</h3>
      <div className="field">
        <label className="label" htmlFor="session-action">
          Allowed action
        </label>
        <input
          id="session-action"
          required
          maxLength={128}
          value={action}
          disabled={busy}
          onChange={(event) => setAction(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="session-resource">
          Exact resource
        </label>
        <input
          id="session-resource"
          required
          maxLength={512}
          value={resource}
          disabled={busy}
          onChange={(event) => setResource(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="session-ttl">
          Maximum lifetime
        </label>
        <select
          id="session-ttl"
          value={ttl}
          disabled={busy}
          onChange={(event) => setTtl(event.target.value)}
        >
          <option value="900">15 minutes</option>
          <option value="3600">1 hour</option>
          <option value="28800">8 hours</option>
        </select>
      </div>
      <p className="hint">
        The immutable ceiling limits this task; executing still requires a
        covering grant.
      </p>
      {error ? (
        <p role="alert" className="note note--err">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !online}
        >
          {busy ? "Starting…" : "Start session"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
