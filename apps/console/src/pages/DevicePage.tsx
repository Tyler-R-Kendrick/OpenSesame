import { approveDevice } from "@opensesame/ceremony-kit";
import { useState } from "react";

const identityApi =
  import.meta.env.VITE_OPENSESAME_ISSUER ??
  import.meta.env.VITE_IDENTITY_API ??
  "http://127.0.0.1:8788";

/**
 * Device authorization approval — distinct from claim ownership.
 * Approves via Identity API (authenticated); operator token stays server-side.
 */
export function DevicePage() {
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function approve() {
    setError(null);
    setStatus(null);
    // Kept ahead of the shared call, which has its own empty-code guard, for two
    // reasons: the field must never flip into its busy/disabled state for input
    // the browser can reject on its own, and this screen is only ever reached
    // from a CLI login, so "terminal" is more precise here than the kit's
    // surface-neutral "device".
    if (!userCode.trim()) {
      setError("Enter the user code shown in your terminal.");
      return;
    }
    setBusy(true);
    try {
      // One implementation of this flow, shared with the ceremonies app
      // (ADR 0045): the status-to-copy mapping lives in the kit so a newly
      // discovered failure mode gets worded once instead of per surface.
      await approveDevice({
        baseUrl: identityApi,
        userCode,
        fetchImpl: fetch,
        // Stated rather than inherited from the kit default: the console has no
        // credential of its own to send, so the Better Auth session cookie is
        // the *only* thing that authenticates this call. A future change to the
        // kit's default must not be able to silently un-authenticate it.
        credentials: "include",
      });
      setStatus("CLI session authorized. You can return to the terminal.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="badge">Authorize CLI</div>
      <h1>Authorize this CLI session</h1>
      <p>
        Enter the user code shown in your terminal. This grants a short-lived
        client session only — it does <strong>not</strong> transfer ownership of
        agents, projects, or resources. Sign in first so the Identity API can
        approve on your behalf (operator credentials never ship to the browser).
      </p>
      <div className="field">
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
      </div>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void approve()}
        >
          {busy ? "Authorizing…" : "Authorize CLI"}
        </button>
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
