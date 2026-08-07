import { useMemo, useState } from "react";

const identityApi = import.meta.env.VITE_IDENTITY_API ?? "http://127.0.0.1:8788";
const hostApi = import.meta.env.VITE_HOST_API ?? "http://127.0.0.1:8787";

/**
 * Mobile MFA PWA — passkey + TOTP step-up against Identity API (:8788).
 */
export function App() {
  const [userCode, setUserCode] = useState("");
  const [principalId, setPrincipalId] = useState("prn_demo");
  const [accessToken, setAccessToken] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [status, setStatus] = useState("Ready for step-up");
  const base = useMemo(() => identityApi.replace(/\/$/, ""), []);

  async function checkIdentity() {
    try {
      const res = await fetch(`${base}/v1/health/live`);
      setStatus(res.ok ? "Identity API reachable" : `Identity API ${res.status}`);
    } catch (e) {
      setStatus(`Identity API offline: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function registerPasskey() {
    const credentialId = `cred_${crypto.randomUUID?.() ?? Date.now()}`;
    const publicKey = btoa("dev-public-key");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    else headers.authorization = `Bearer ${principalId}`;

    const res = await fetch(`${base}/v1/mfa/passkey/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId, publicKey, counter: 0 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(`Passkey register failed: ${res.status} ${JSON.stringify(body)}`);
      return;
    }
    const assertRes = await fetch(`${base}/v1/mfa/passkey/assert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialId,
        clientDataJSON: btoa("{}"),
        authenticatorData: btoa("auth"),
        signature: btoa("sig-bytes"),
      }),
    });
    const assertBody = await assertRes.json().catch(() => ({}));
    setStatus(
      assertRes.ok
        ? `Passkey registered + asserted for ${assertBody.principalId ?? principalId}`
        : `Assert failed: ${JSON.stringify(assertBody)}`,
    );
  }

  async function enrollTotp() {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    else headers.authorization = `Bearer ${principalId}`;
    const res = await fetch(`${base}/v1/mfa/totp/enroll`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const body = (await res.json().catch(() => ({}))) as {
      secret?: string;
      otpauthUrl?: string;
    };
    if (!res.ok) {
      setStatus(`TOTP enroll failed: ${res.status}`);
      return;
    }
    setTotpSecret(body.secret ?? "");
    setStatus(`TOTP enrolled. otpauth=${body.otpauthUrl ?? ""}`);
  }

  async function verifyTotp() {
    const res = await fetch(`${base}/v1/mfa/totp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId, code: totpCode }),
    });
    const body = await res.json().catch(() => ({}));
    setStatus(res.ok && body.ok ? "TOTP verified" : `TOTP failed: ${JSON.stringify(body)}`);
  }

  async function approveDevice() {
    try {
      const res = await fetch(`${hostApi.replace(/\/$/, "")}/api/v1/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode, principal: principalId }),
      });
      setStatus(
        res.ok
          ? `Device code ${userCode} approved on Host API`
          : `Approve failed: ${res.status}`,
      );
    } catch (e) {
      setStatus(`Host API offline: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <main className="mfa">
      <p className="brand">OpenSesame</p>
      <h1>Mobile MFA</h1>
      <p className="lede">
        Passkey / TOTP step-up against the Identity API (:8788). Device approval can also hit the
        Host API (:8787).
      </p>

      <section>
        <h2>Session</h2>
        <label>
          Principal id
          <input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} />
        </label>
        <label>
          Access token (pst_… or enable OPENSESAME_ALLOW_PRINCIPAL_BEARER)
          <input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
        </label>
      </section>

      <section>
        <h2>Device approval</h2>
        <label>
          User code
          <input
            value={userCode}
            onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
          />
        </label>
        <button type="button" onClick={() => void approveDevice()}>
          Approve on Host API
        </button>
      </section>

      <section>
        <h2>Passkey / TOTP</h2>
        <div className="row">
          <button type="button" onClick={() => void checkIdentity()}>
            Check Identity API
          </button>
          <button type="button" onClick={() => void registerPasskey()}>
            Register + assert passkey
          </button>
          <button type="button" onClick={() => void enrollTotp()}>
            Enroll TOTP
          </button>
        </div>
        {totpSecret ? <p className="hint">Secret (base64): {totpSecret}</p> : null}
        <label>
          TOTP code
          <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
        </label>
        <button type="button" onClick={() => void verifyTotp()}>
          Verify TOTP
        </button>
        <p className="status" role="status">
          {status}
        </p>
      </section>
    </main>
  );
}
