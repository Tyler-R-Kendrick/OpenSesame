import { useState } from "react";

const hostApi =
  import.meta.env.VITE_OPENSESAME_HOST_API ??
  import.meta.env.VITE_OPENSESAME_API_URL ??
  "http://127.0.0.1:8787";

const operatorToken =
  import.meta.env.VITE_OPENSESAME_OPERATOR_TOKEN ?? "opensesame-dev-operator";

/**
 * Device authorization approval — distinct from claim ownership.
 * Copy must say "Authorize CLI", never "Claim".
 */
export function DevicePage() {
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    try {
      const res = await fetch(`${hostApi.replace(/\/$/, "")}/api/v1/device/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opensesame-operator": operatorToken,
        },
        body: JSON.stringify({ user_code: userCode.trim() }),
      });
      if (!res.ok) {
        throw new Error(`Approval failed (${res.status})`);
      }
      setStatus("CLI session authorized. You can return to the terminal.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="panel">
      <div className="badge">Authorize CLI</div>
      <h1>Authorize this CLI session</h1>
      <p>
        Enter the user code shown in your terminal. This grants a short-lived
        client session only — it does <strong>not</strong> transfer ownership of
        agents, projects, or resources.
      </p>
      <label htmlFor="user-code">User code</label>
      <input
        id="user-code"
        autoComplete="one-time-code"
        placeholder="ABCD-EFGH"
        value={userCode}
        onChange={(e) => setUserCode(e.target.value.toUpperCase())}
      />
      <div className="actions">
        <button type="button" className="primary" onClick={() => void approve()}>
          Authorize CLI
        </button>
      </div>
      {status ? <p>{status}</p> : null}
      {error ? <p className="err">{error}</p> : null}
    </section>
  );
}
