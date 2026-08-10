import { useState } from "react";
import { Link } from "react-router";
import { enqueue, loadQueue } from "../lib/queue.js";
import { loadSettings } from "../lib/settings.js";
import { track } from "../lib/telemetry.js";
import { credentialsFor } from "../lib/urls.js";

export function AuthorizePage({ online }: { online: boolean }) {
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    setStatus(null);
    const code = userCode.trim().toUpperCase();
    if (!code) {
      setError("Enter the user code from your terminal.");
      return;
    }

    if (!online) {
      enqueue({ kind: "device_approve", userCode: code });
      track("ceremony_queued", { queue_depth: loadQueue().length });
      setStatus(
        "Offline — approval queued. Open Queue when you are back online.",
      );
      return;
    }

    setBusy(true);
    try {
      const { identityApi } = loadSettings();
      const base = identityApi.replace(/\/$/, "");
      const res = await fetch(`${base}/v1/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: credentialsFor(base),
        body: JSON.stringify({ user_code: code }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error("Sign in at the Identity API first, then approve.");
        }
        throw new Error(`Approval failed (${res.status}).`);
      }
      track("ceremony_completed");
      setStatus("CLI session authorized. Return to the terminal.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h1>Authorize CLI</h1>
      <p>
        Grants a short-lived client session only — it does <strong>not</strong>{" "}
        transfer ownership. That ceremony lives under{" "}
        <Link to="/claim">Claim ownership</Link>. Approvals go to the Identity
        API, not the Host API.
      </p>
      {!online ? (
        <output className="warn">
          You are offline. Approvals will be queued until connectivity returns.
        </output>
      ) : null}
      <label htmlFor="user-code">User code</label>
      <input
        id="user-code"
        autoComplete="one-time-code"
        placeholder="ABCD-EFGH"
        value={userCode}
        disabled={busy}
        onChange={(e) => setUserCode(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter") void approve();
        }}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void approve()}
        >
          {busy ? "Authorizing…" : online ? "Authorize CLI" : "Queue approval"}
        </button>
        <Link className="button" to="/claim">
          Claim ownership
        </Link>
      </div>
      {status ? <output className="ok">{status}</output> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
