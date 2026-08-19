import { approveDevice } from "@opensesame/ceremony-kit";
import { useEffect, useState } from "react";
import { parseUserCode } from "../lib/deep-link.js";
import { issuer } from "../lib/issuer.js";

/**
 * Device authorization approval — distinct from claim ownership. Approves via
 * the Identity API using the signed-in browser session; operator credentials
 * never ship to the browser. Deep-linkable as `/device?user_code=XXXX-XXXX`
 * (the code is a display artifact, unlike claim bearers, so the query string
 * is an acceptable carrier).
 */
export function DeviceApprove() {
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fromLink = parseUserCode(window.location.search);
    if (fromLink) setUserCode(fromLink);
  }, []);

  async function approve() {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      // One implementation of this flow, shared with Pages and the console.
      await approveDevice({
        baseUrl: issuer,
        userCode,
        fetchImpl: fetch,
      });
      setStatus("Device authorized. You can return to it now.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="badge">Approve a device</div>
      <h1>Approve this device or CLI</h1>
      <p>
        Enter the user code shown on the device. This grants a short-lived
        client session only — it does <strong>not</strong> transfer ownership of
        agents, projects, or resources.
      </p>
      <div className="field">
        <label htmlFor="user-code">User code</label>
        <input
          id="user-code"
          autoComplete="one-time-code"
          inputMode="text"
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
          {busy ? "Approving…" : "Approve device"}
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
