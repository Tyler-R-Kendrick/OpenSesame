import {
  creationOptionsFromJson,
  isPublicKeyCredential,
  parsePublicKeyCredentialCreationOptionsJson,
  registrationResponseJson,
} from "@opensesame/sdk-browser";
import { useState } from "react";
import { QrCode } from "./QrCode.js";
import { type Notice, Status } from "./Status.js";
import {
  assertPasskey,
  identityBase,
  jsonHeaders,
  responseObject,
  stringField,
  verifyTotpCode,
} from "./identity.js";

/**
 * Enrolling the authenticators an approval will later use.
 *
 * Deliberately not an approval surface. Registering a passkey or minting a
 * TOTP secret is maintenance a person does once, on their own schedule, and it
 * has nothing to say about a question somebody else is waiting on — so when
 * this app is opened on an interaction link, `App` folds this whole section
 * behind a closed disclosure rather than stacking it beside the decision.
 */

type Busy = "check" | "passkey" | "enroll" | "verify" | null;

export interface EnrolmentProps {
  token: string;
}

export function Enrolment({ token }: EnrolmentProps) {
  const [totpSecret, setTotpSecret] = useState("");
  const [totpOtpauthUrl, setTotpOtpauthUrl] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  /**
   * Every route below is authenticated, so the bearer is checked once here.
   *
   * Returned rather than thrown: this is a field the human can fill in, not a
   * failure, and reporting it as an error the moment they press a button is
   * how they find out.
   */
  function bearer(): string | null {
    const held = token.trim();
    if (held.length === 0) {
      setNotice({
        kind: "err",
        text: "Paste a session access token (pst_…) first.",
      });
      return null;
    }
    return held;
  }

  async function checkIdentity() {
    setBusy("check");
    try {
      const res = await fetch(`${identityBase}/v1/health/live`);
      setNotice(
        res.ok
          ? { kind: "ok", text: "Identity API reachable" }
          : { kind: "err", text: `Identity API returned ${res.status}` },
      );
    } catch (e) {
      setNotice({
        kind: "err",
        text: `Identity API offline: ${e instanceof Error ? e.message : e}`,
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Register a passkey, then immediately assert it.
   *
   * The assertion is not ceremony for its own sake: a credential that
   * registered but cannot be asserted is exactly the credential a person
   * discovers is useless at the moment they most need it, which on this app is
   * an approval screen with a countdown on it.
   */
  async function registerPasskey() {
    const held = bearer();
    if (held === null) return;
    if (!window.PublicKeyCredential) {
      setNotice({
        kind: "err",
        text: "This browser does not support WebAuthn.",
      });
      return;
    }
    setBusy("passkey");
    try {
      const optionsRes = await fetch(
        `${identityBase}/v1/mfa/passkey/registration-options`,
        { method: "POST", headers: jsonHeaders(held) },
      );
      const optionsBody = await responseObject(optionsRes);
      const options = parsePublicKeyCredentialCreationOptionsJson(
        optionsBody?.options,
      );
      if (!optionsRes.ok || !options) {
        setNotice({
          kind: "err",
          text:
            stringField(optionsBody, "hint") ??
            stringField(optionsBody, "error") ??
            `Registration options failed (${optionsRes.status})`,
        });
        return;
      }
      const created = await navigator.credentials.create(
        creationOptionsFromJson(options),
      );
      if (!created) {
        setNotice({ kind: "err", text: "Passkey creation was cancelled." });
        return;
      }
      if (!isPublicKeyCredential(created)) {
        setNotice({
          kind: "err",
          text: "Passkey creation returned an invalid credential.",
        });
        return;
      }
      const registerRes = await fetch(
        `${identityBase}/v1/mfa/passkey/register`,
        {
          method: "POST",
          headers: jsonHeaders(held),
          body: JSON.stringify({ response: registrationResponseJson(created) }),
        },
      );
      const registerBody = await responseObject(registerRes);
      if (!registerRes.ok) {
        setNotice({
          kind: "err",
          text:
            stringField(registerBody, "hint") ??
            stringField(registerBody, "error") ??
            `Passkey register failed (${registerRes.status})`,
        });
        return;
      }
      const principal = stringField(registerBody, "principalId") ?? "session";
      try {
        await assertPasskey(held);
        setNotice({ kind: "ok", text: `Passkey registered for ${principal}.` });
      } catch (e) {
        // Registration already succeeded, so this is not a failed enrolment —
        // it is a working credential this browser could not exercise. Saying
        // "registered" and then what went wrong is the honest report; calling
        // the whole thing failed would send the human to register a second one.
        setNotice({
          kind: "err",
          text: `Passkey registered for ${principal}, but not asserted: ${
            e instanceof Error ? e.message : "unknown error"
          }`,
        });
      }
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Passkey ceremony failed",
      });
    } finally {
      setBusy(null);
    }
  }

  async function enrollTotp() {
    const held = bearer();
    if (held === null) return;
    setBusy("enroll");
    try {
      const res = await fetch(`${identityBase}/v1/mfa/totp/enroll`, {
        method: "POST",
        headers: jsonHeaders(held),
        body: "{}",
      });
      const body = await responseObject(res);
      if (!res.ok) {
        setNotice({
          kind: "err",
          text:
            stringField(body, "hint") ??
            stringField(body, "error") ??
            `TOTP enroll failed (${res.status})`,
        });
        return;
      }
      setTotpSecret(stringField(body, "secret") ?? "");
      setTotpOtpauthUrl(stringField(body, "otpauthUrl") ?? "");
      setNotice({
        kind: "ok",
        text: "TOTP enrolled. Scan or copy the secret.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    const held = bearer();
    if (held === null) return;
    setBusy("verify");
    try {
      await verifyTotpCode(held, totpCode);
      setNotice({ kind: "ok", text: "TOTP verified" });
    } catch {
      // One sentence for every way this fails. A rejected code, a rate limit
      // and an unreachable host are the same fact to the person typing: the
      // code did not take. Distinguishing them here would also tell an
      // attacker holding a stolen token which codes were close.
      setNotice({ kind: "err", text: "TOTP verification failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Authenticators</h2>
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
          aria-busy={busy === "passkey"}
          onClick={() => void registerPasskey()}
        >
          Register passkey
        </button>
        <button
          type="button"
          disabled={busy !== null}
          aria-busy={busy === "enroll"}
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
      <div className="field">
        <label htmlFor="totp-code">TOTP code</label>
        <input
          id="totp-code"
          value={totpCode}
          onChange={(e) => setTotpCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          disabled={busy !== null}
        />
      </div>
      <button
        type="button"
        disabled={busy !== null}
        aria-busy={busy === "verify"}
        onClick={() => void verify()}
      >
        Verify TOTP
      </button>
      <Status notice={notice} />
    </section>
  );
}
