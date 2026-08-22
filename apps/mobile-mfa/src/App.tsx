import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { useEffect, useMemo, useState } from "react";
import { QrCode } from "./QrCode.js";
import {
  assertionPayload,
  creationOptionsFromJson,
  isPublicKeyCredential,
  parsePublicKeyCredentialCreationOptionsJson,
  parsePublicKeyCredentialRequestOptionsJson,
  registrationResponseJson,
  requestOptionsFromJson,
} from "./webauthn.js";

const identityApi =
  import.meta.env.VITE_IDENTITY_API ?? "http://127.0.0.1:8788";

type StatusKind = "info" | "ok" | "err";

async function responseObject(response: Response): Promise<JsonObject | null> {
  const value: BoundaryValue = await response.json().catch(() => null);
  return isJsonObject(value) ? value : null;
}

function stringField(body: JsonObject | null, key: string): string | undefined {
  return readString(body?.[key]);
}

function parseDeepLink() {
  if (window === undefined) return {};
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
  const [principalId, setPrincipalId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpOtpauthUrl, setTotpOtpauthUrl] = useState("");
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
        setStatusKind("info");
        setStatus(`Deep-link user code ${next.userCode}`);
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

  function authHeaders(): Record<string, string> | null {
    const token = accessToken.trim();
    if (!token) {
      report(
        "err",
        "Paste a session access token (pst_…) first — principal Bearer is not accepted.",
      );
      return null;
    }
    return {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  async function registerPasskey() {
    setBusy("passkey");
    const headers = authHeaders();
    if (!headers) {
      setBusy(null);
      return;
    }
    if (!window.PublicKeyCredential) {
      report("err", "This browser does not support WebAuthn.");
      setBusy(null);
      return;
    }

    try {
      const optsRes = await fetch(
        `${base}/v1/mfa/passkey/registration-options`,
        {
          method: "POST",
          headers,
        },
      );
      const optsBody = await responseObject(optsRes);
      const options = parsePublicKeyCredentialCreationOptionsJson(
        optsBody?.options,
      );
      if (!optsRes.ok || !options) {
        report(
          "err",
          stringField(optsBody, "hint") ??
            stringField(optsBody, "error") ??
            `Registration options failed (${optsRes.status})`,
        );
        return;
      }
      const cred = await navigator.credentials.create(
        creationOptionsFromJson(options),
      );
      if (!cred) {
        report("err", "Passkey creation was cancelled.");
        return;
      }
      if (!isPublicKeyCredential(cred)) {
        report("err", "Passkey creation returned an invalid credential.");
        return;
      }
      const reg = await fetch(`${base}/v1/mfa/passkey/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ response: registrationResponseJson(cred) }),
      });
      const regBody = await responseObject(reg);
      if (!reg.ok) {
        report(
          "err",
          stringField(regBody, "hint") ??
            stringField(regBody, "error") ??
            `Passkey register failed (${reg.status})`,
        );
        return;
      }

      const authOptsRes = await fetch(
        `${base}/v1/mfa/passkey/authentication-options`,
        {
          method: "POST",
          headers,
        },
      );
      const authOptsBody = await responseObject(authOptsRes);
      const authOptions = parsePublicKeyCredentialRequestOptionsJson(
        authOptsBody?.options,
      );
      if (!authOptsRes.ok || !authOptions) {
        report(
          "ok",
          `Passkey registered for ${stringField(regBody, "principalId") ?? "session"} — assert options unavailable`,
        );
        return;
      }
      const assertion = await navigator.credentials.get(
        requestOptionsFromJson(authOptions),
      );
      if (!assertion) {
        report(
          "ok",
          `Passkey registered for ${stringField(regBody, "principalId") ?? "session"}`,
        );
        return;
      }
      if (!isPublicKeyCredential(assertion)) {
        report("err", "Passkey authentication returned an invalid credential.");
        return;
      }
      const assertRes = await fetch(`${base}/v1/mfa/passkey/assert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assertionPayload(assertion)),
      });
      const assertBody = await responseObject(assertRes);
      report(
        assertRes.ok ? "ok" : "err",
        assertRes.ok
          ? `Passkey registered and asserted for ${stringField(assertBody, "principalId") ?? stringField(regBody, "principalId") ?? "session"}`
          : "Passkey assert failed",
      );
    } catch (e) {
      report("err", e instanceof Error ? e.message : "Passkey ceremony failed");
    } finally {
      setBusy(null);
    }
  }

  async function enrollTotp() {
    setBusy("enroll");
    const headers = authHeaders();
    if (!headers) {
      setBusy(null);
      return;
    }
    try {
      const res = await fetch(`${base}/v1/mfa/totp/enroll`, {
        method: "POST",
        headers,
        body: "{}",
      });
      const body = await responseObject(res);
      if (!res.ok) {
        report(
          "err",
          stringField(body, "hint") ??
            stringField(body, "error") ??
            `TOTP enroll failed (${res.status})`,
        );
        return;
      }
      setTotpSecret(stringField(body, "secret") ?? "");
      setTotpOtpauthUrl(stringField(body, "otpauthUrl") ?? "");
      report("ok", "TOTP enrolled. Scan or copy the secret below.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyTotp() {
    setBusy("verify");
    const headers = authHeaders();
    if (!headers) {
      setBusy(null);
      return;
    }
    try {
      const res = await fetch(`${base}/v1/mfa/totp/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code: totpCode }),
      });
      const body = await responseObject(res);
      const verified = body?.ok === true;
      report(
        res.ok && verified ? "ok" : "err",
        res.ok && verified ? "TOTP verified" : "TOTP verification failed",
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
      const headers = authHeaders();
      if (!headers) {
        setBusy(null);
        return;
      }
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
        ({base}). Passkeys use the platform authenticator via
        <code>/v1/mfa/passkey/registration-options</code>. TOTP enroll is
        dev-defaults only.
      </p>

      {claimId ? (
        <output className="hint">
          Deep-link claim id <code>{claimId}</code> — complete ownership claims
          in the Identity console, not this MFA surface.
        </output>
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
          Principal id (device approve only)
          <input
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        <label>
          Access token (required for MFA)
          <input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            disabled={busy !== null}
            autoComplete="off"
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
        {totpOtpauthUrl || totpSecret ? (
          <div className="totp-enroll">
            {totpOtpauthUrl ? (
              <QrCode
                value={totpOtpauthUrl}
                label="Scan to enroll this TOTP secret in an authenticator app"
              />
            ) : null}
            {totpSecret ? (
              <p className="hint">Secret (base64): {totpSecret}</p>
            ) : null}
            {totpOtpauthUrl ? (
              <p className="hint">
                otpauth: <code>{totpOtpauthUrl}</code>
              </p>
            ) : null}
          </div>
        ) : null}
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
