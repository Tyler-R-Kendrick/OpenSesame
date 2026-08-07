import { useEffect, useMemo, useState } from "react";

const identityApi = import.meta.env.VITE_IDENTITY_API ?? "http://127.0.0.1:8788";

type StatusKind = "info" | "ok" | "err";

function parseDeepLink(): { userCode?: string; claimId?: string } {
  if (typeof window === "undefined") return {};
  const url = new URL(window.location.href);
  const userCode =
    url.searchParams.get("user_code") ??
    url.searchParams.get("code") ??
    undefined;
  const claimId = url.searchParams.get("claim_id") ?? undefined;
  if (url.protocol.startsWith("opensesame")) {
    return {
      userCode: url.searchParams.get("user_code") ?? userCode,
      claimId: url.searchParams.get("claim_id") ?? claimId,
    };
  }
  return { userCode: userCode ?? undefined, claimId: claimId ?? undefined };
}

/**
 * Mobile MFA PWA — passkey + TOTP step-up against Identity API (:8788).
 * Deep-link: /?user_code=ABCD-EFGH or opensesame-mfa://approve?user_code=…
 */
export function App() {
  const deep = useMemo(() => parseDeepLink(), []);
  const [userCode, setUserCode] = useState(deep.userCode ?? "");
  const [claimId] = useState(deep.claimId ?? "");
  const [principalId, setPrincipalId] = useState("prn_demo");
  const [accessToken, setAccessToken] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [status, setStatus] = useState(
    deep.userCode
      ? `Deep-link user code ${deep.userCode} — review and approve`
      : "Ready for step-up",
  );
  const [statusKind, setStatusKind] = useState<StatusKind>("info");
  const [busy, setBusy] = useState<string | null>(null);
  const base = useMemo(() => identityApi.replace(/\/$/, ""), []);

  function report(kind: StatusKind, message: string) {
    setStatusKind(kind);
    setStatus(message);
  }

  useEffect(() => {
    const onHash = () => {
      const next = parseDeepLink();
      if (next.userCode) {
        setUserCode(next.userCode);
        report("info", `Deep-link user code ${next.userCode}`);
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  async function checkIdentity() {
    setBusy("check");
    try {
      const res = await fetch(`${base}/v1/health/live`);
      report(
        res.ok ? "ok" : "err",
        res.ok
          ? "Identity API reachable"
          : `Identity API returned ${res.status}`,
      );
    } catch (e) {
      report(
        "err",
        `Identity API offline: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function registerPasskey() {
    setBusy("passkey");
    const credentialId = `cred_${crypto.randomUUID?.() ?? Date.now()}`;
    const publicKey = btoa("dev-public-key");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    else headers.authorization = `Bearer ${principalId}`;

    try {
      const res = await fetch(`${base}/v1/mfa/passkey/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ credentialId, publicKey, counter: 0 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        report("err", `Passkey register failed (${res.status})`);
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
      const assertBody = (await assertRes.json().catch(() => ({}))) as {
        principalId?: string;
      };
      report(
        assertRes.ok ? "ok" : "err",
        assertRes.ok
          ? `Passkey registered for ${assertBody.principalId ?? principalId} (dev fixture)`
          : "Passkey assert failed",
      );
    } finally {
      setBusy(null);
    }
  }

  async function enrollTotp() {
    setBusy("enroll");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    else headers.authorization = `Bearer ${principalId}`;
    try {
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
        report("err", `TOTP enroll failed (${res.status})`);
        return;
      }
      setTotpSecret(body.secret ?? "");
      report("ok", "TOTP enrolled. Scan or copy the secret below.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyTotp() {
    setBusy("verify");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    else headers.authorization = `Bearer ${principalId}`;
    try {
      const res = await fetch(`${base}/v1/mfa/totp/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code: totpCode }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      report(
        res.ok && body.ok ? "ok" : "err",
        res.ok && body.ok ? "TOTP verified" : "TOTP verification failed",
      );
    } finally {
      setBusy(null);
    }
  }

  async function approveDevice() {
    if (!userCode.trim()) {
      report("err", "Enter the user code from your terminal.");
      return;
    }
    setBusy("approve");
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (accessToken) headers.authorization = `Bearer ${accessToken}`;
      else headers.authorization = `Bearer ${principalId}`;
      const res = await fetch(`${base}/v1/device/approve`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ user_code: userCode, principal: principalId }),
      });
      report(
        res.ok ? "ok" : "err",
        res.ok
          ? `Device code ${userCode} approved via Identity API`
          : res.status === 401 || res.status === 403
            ? "Sign in or provide a valid token, then try again."
            : `Approve failed (${res.status})`,
      );
    } catch (e) {
      report(
        "err",
        `Identity API offline: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      setBusy(null);
    }
  }

  const deepLinkPrimary = Boolean(deep.userCode || userCode);

  return (
    <main className="mfa">
      <p className="brand">OpenSesame</p>
      <h1>Mobile MFA</h1>
      <p className="lede">
        Passkey / TOTP step-up and CLI device approval against the Identity API
        ({base}). Passkey register here uses a <strong>dev fixture</strong>, not
        a platform authenticator.
      </p>

      {claimId ? (
        <p className="hint" role="status">
          Deep-link claim id <code>{claimId}</code> — complete ownership claims
          in the Identity console, not this MFA surface.
        </p>
      ) : null}

      <section className={deepLinkPrimary ? "priority" : undefined}>
        <h2>Authorize CLI</h2>
        <p className="hint">
          Same ceremony as the console “Authorize CLI” page. Approves via
          Identity API — not the Host API.
        </p>
        <label>
          User code
          <input
            value={userCode}
            onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            disabled={busy !== null}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          aria-busy={busy === "approve"}
          onClick={() => void approveDevice()}
        >
          {busy === "approve" ? "Approving…" : "Approve device code"}
        </button>
      </section>

      <section>
        <h2>Session</h2>
        <label>
          Principal id
          <input
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        <label>
          Access token (optional pst_…)
          <input
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            disabled={busy !== null}
          />
        </label>
      </section>

      <section>
        <h2>Passkey / TOTP</h2>
        <div className="row">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void checkIdentity()}
          >
            Check Identity API
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void registerPasskey()}
          >
            Register + assert passkey
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void enrollTotp()}
          >
            Enroll TOTP
          </button>
        </div>
        {totpSecret ? <p className="hint">Secret (base64): {totpSecret}</p> : null}
        <label>
          TOTP code
          <input
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void verifyTotp()}
        >
          Verify TOTP
        </button>
      </section>

      <p
        className={`status status-${statusKind}`}
        role={statusKind === "err" ? "alert" : "status"}
      >
        {status}
      </p>
    </main>
  );
}
