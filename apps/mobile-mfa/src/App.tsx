import { useMemo, useState } from "react";

const identityApi = import.meta.env.VITE_IDENTITY_API ?? "http://127.0.0.1:8788";

/**
 * Mobile MFA PWA — step-up against Identity API.
 * Passkey ceremony uses browser WebAuthn; TOTP is enrollment UX only in this slice
 * (server verification via Identity control-plane / Better Auth when configured).
 */
export function App() {
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState("Ready for step-up");
  const deviceUrl = useMemo(
    () => `${identityApi.replace(/\/$/, "")}/device`,
    [],
  );

  async function checkIdentity() {
    try {
      const res = await fetch(`${identityApi.replace(/\/$/, "")}/v1/health/live`);
      setStatus(res.ok ? "Identity API reachable" : `Identity API ${res.status}`);
    } catch (e) {
      setStatus(`Identity API offline: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function registerPasskeyHint() {
    if (!window.PublicKeyCredential) {
      setStatus("WebAuthn not available in this browser");
      return;
    }
    setStatus(
      "Use Identity console passkey enrollment, or POST /v1/passkeys/* when session is authenticated.",
    );
  }

  return (
    <main className="mfa">
      <p className="brand">OpenSesame</p>
      <h1>Mobile MFA</h1>
      <p className="lede">
        Approve host device codes and manage phishing-resistant step-up against the Identity API
        (not the Host API).
      </p>

      <section>
        <h2>Device approval</h2>
        <p>
          Open <a href={deviceUrl}>{deviceUrl}</a> after signing in, then enter the user code from{" "}
          <code>opensesame login --device</code> or <code>opensesame-id login --device</code>.
        </p>
        <label>
          User code
          <input
            value={userCode}
            onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            inputMode="text"
          />
        </label>
        <p className="hint">Complete approval in the identity console device page (same code).</p>
      </section>

      <section>
        <h2>Passkey / TOTP</h2>
        <div className="row">
          <button type="button" onClick={() => void checkIdentity()}>
            Check Identity API
          </button>
          <button type="button" onClick={() => void registerPasskeyHint()}>
            Passkey guidance
          </button>
        </div>
        <p className="status" role="status">
          {status}
        </p>
      </section>
    </main>
  );
}
