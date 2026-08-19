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
    if (!userCode.trim()) {
      setError("Enter the user code shown on the device.");
      return;
    }
    setBusy(true);
    try {
      const base = issuer.replace(/\/$/, "");
      const res = await fetch(`${base}/v1/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode.trim() }),
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error(
            "Sign in first (same hostname as this page — mixed localhost/127.0.0.1 drops the session cookie), then approve this code.",
          );
        }
        if (res.status === 404) {
          throw new Error("That user code was not found or has expired.");
        }
        throw new Error(`Approval failed (${res.status}). Try again shortly.`);
      }
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
