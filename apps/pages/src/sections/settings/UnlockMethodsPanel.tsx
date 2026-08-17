import { type FormEvent, useEffect, useState } from "react";
import { IconAlert, IconPasskey, IconShield } from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { estimateStrength } from "../../lib/vault/password.js";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  type WebauthnHostCheck,
} from "../../lib/vault/unlock-methods.js";

const ENROLL_PASSKEY_FLAG = "os:enroll-passkey-after-host-fix";

function Status({
  message,
}: { message: { tone: "ok" | "err"; text: string } | null }) {
  if (!message) return null;
  return (
    <p
      className={`note note--${message.tone}`}
      role={message.tone === "err" ? "alert" : "status"}
    >
      <span>{message.text}</span>
    </p>
  );
}

export function UnlockMethodsPanel() {
  const { header } = useVault();
  const store = useVaultStore();
  const methods = listAvailableUnlockMethods(header);
  const hasPasskey = Boolean(header?.unlocks?.passkey);
  const hasPin = Boolean(header?.unlocks?.pin);
  const hasPassword = Boolean(header?.wrap && header?.kdf);
  const hasTotp = Boolean(header?.unlocks?.totp);

  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [webauthnHost, setWebauthnHost] = useState<WebauthnHostCheck>(() =>
    checkWebauthnHost(),
  );

  useEffect(() => {
    setWebauthnHost(checkWebauthnHost());
  }, []);

  useEffect(() => {
    if (hasPasskey || busy) return;
    if (sessionStorage.getItem(ENROLL_PASSKEY_FLAG) !== "1") return;
    if (!checkWebauthnHost().ok) return;
    sessionStorage.removeItem(ENROLL_PASSKEY_FLAG);
    void run(
      () => store.enrollPasskey(),
      "Passkey unlock enrolled.",
    );
  }, [hasPasskey, busy, store]);

  async function run(action: () => Promise<void>, ok: string) {
    setMessage(null);
    setBusy(true);
    try {
      await action();
      setMessage({ tone: "ok", text: ok });
    } catch (caught) {
      setMessage({
        tone: "err",
        text: describeWebauthnError(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  function healPasskeyHost() {
    const check = checkWebauthnHost();
    if (!check.fixUrl) {
      setMessage({ tone: "err", text: formatFallback(check) });
      return;
    }
    sessionStorage.setItem(ENROLL_PASSKEY_FLAG, "1");
    window.location.assign(check.fixUrl);
  }

  function formatFallback(check: WebauthnHostCheck): string {
    return check.fixUrl
      ? check.reason
      : `${check.reason} Open this app on a DNS hostname, then enroll again.`;
  }

  function enrollPinForm(event: FormEvent) {
    event.preventDefault();
    if (pin !== pinConfirm) {
      setMessage({ tone: "err", text: "The two PINs do not match." });
      return;
    }
    void run(async () => {
      await store.enrollPin(pin);
      setPin("");
      setPinConfirm("");
    }, "PIN unlock enrolled. You can unlock with this PIN next time.");
  }

  function enrollPasswordForm(event: FormEvent) {
    event.preventDefault();
    if (password !== passwordConfirm) {
      setMessage({ tone: "err", text: "The two passwords do not match." });
      return;
    }
    void run(async () => {
      await store.enrollPassword(password);
      setPassword("");
      setPasswordConfirm("");
    }, "Password unlock enrolled.");
  }

  const pinStrengthOk =
    pin.length >= MIN_PIN_LENGTH && pin.length <= MAX_PIN_LENGTH;
  const passwordStrength = estimateStrength(password);
  const passwordOk =
    password.length >= 12 &&
    passwordStrength.score >= 2 &&
    password === passwordConfirm;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Unlock methods</h2>
          <p>
            Primary unlock can be a passkey (WebAuthn PRF), a short PIN, or a
            master password. Optional authenticator MFA runs after any primary
            method succeeds.
          </p>
        </div>
      </div>
      <div className="panel__body set__unlock">
        <Status message={message} />

        <div className="set__unlock-row">
          <div>
            <h3>
              <IconPasskey size={16} /> Passkey
            </h3>
            <p className="hint">
              {hasPasskey
                ? "Enrolled. Platform authenticator unwraps the vault key via PRF."
                : "Requires a PRF-capable platform passkey (Chrome / Edge on supported OS)."}
            </p>
            {!hasPasskey && !webauthnHost.ok ? (
              <p className="note note--warn" role="status">
                <IconAlert size={18} />
                <span>
                  {webauthnHost.reason}
                  {webauthnHost.fixUrl ? (
                    <>
                      {" "}
                      Passkeys cannot use a raw IP. Continue on{" "}
                      <code>localhost</code> — same vault data — then enrollment
                      resumes automatically.
                    </>
                  ) : (
                    <> Use a DNS hostname (Tailscale MagicDNS, or localhost for local dev).</>
                  )}
                </span>
              </p>
            ) : null}
          </div>
          <div className="actions">
            {hasPasskey ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy || methods.length < 2}
                onClick={() =>
                  void run(
                    () => store.removePasskey(),
                    "Passkey unlock removed.",
                  )
                }
              >
                Remove
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={busy || !webauthnHost.ok}
                  onClick={() =>
                    void run(
                      () => store.enrollPasskey(),
                      "Passkey unlock enrolled.",
                    )
                  }
                >
                  Enroll passkey
                </button>
                {!webauthnHost.ok && webauthnHost.fixUrl ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={healPasskeyHost}
                  >
                    Continue on localhost
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="set__unlock-row">
          <div>
            <h3>
              <IconShield size={16} /> PIN
            </h3>
            <p className="hint">
              {hasPin
                ? "Enrolled. Same PBKDF2 wrap path as the master password, shorter input."
                : `${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} characters. Not a substitute for a strong password on hostile devices.`}
            </p>
          </div>
          {hasPin ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy || methods.length < 2}
              onClick={() =>
                void run(() => store.removePin(), "PIN unlock removed.")
              }
            >
              Remove
            </button>
          ) : (
            <form className="set__unlock-form" onSubmit={enrollPinForm}>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                placeholder="PIN"
                value={pin}
                maxLength={MAX_PIN_LENGTH}
                onChange={(e) => setPin(e.target.value)}
                aria-label="New PIN"
              />
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                placeholder="Confirm"
                value={pinConfirm}
                maxLength={MAX_PIN_LENGTH}
                onChange={(e) => setPinConfirm(e.target.value)}
                aria-label="Confirm PIN"
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={busy || !pinStrengthOk || pin !== pinConfirm}
              >
                Enroll PIN
              </button>
            </form>
          )}
        </div>

        <div className="set__unlock-row">
          <div>
            <h3>Password</h3>
            <p className="hint">
              {hasPassword
                ? "Master-password wrap is available on the unlock screen."
                : "Optional if you already have a passkey or PIN. Same strength rules as first-run."}
            </p>
          </div>
          {hasPassword ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy || methods.length < 2}
              onClick={() =>
                void run(
                  () => store.removePassword(),
                  "Password unlock removed.",
                )
              }
            >
              Remove
            </button>
          ) : (
            <form className="set__unlock-form" onSubmit={enrollPasswordForm}>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="New master password"
              />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                aria-label="Confirm master password"
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={busy || !passwordOk}
              >
                Enroll password
              </button>
            </form>
          )}
        </div>

        <div className="set__unlock-row">
          <div>
            <h3>Authenticator MFA</h3>
            <p className="hint">
              {hasTotp
                ? "Required after every primary unlock on this device."
                : "Optional second factor. The seed is sealed under the vault key."}
            </p>
          </div>
          {hasTotp ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => {
                setTotpUri(null);
                void run(
                  () => store.removeTotp(),
                  "Authenticator MFA removed.",
                );
              }}
            >
              Remove MFA
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const uri = await store.enrollTotp();
                  setTotpUri(uri);
                }, "Authenticator MFA enrolled. Scan the QR before you lock.")
              }
            >
              Enroll MFA
            </button>
          )}
        </div>

        {totpUri ? (
          <div className="set__unlock-totp">
            <QrCode value={totpUri} label="Scan to add vault MFA" size={160} />
            <p className="hint">
              Scan once with your authenticator, then lock and unlock to confirm
              the flow. The secret is not shown again after you leave Settings.
            </p>
            <code className="set__unlock-secret">{totpUri}</code>
          </div>
        ) : null}
      </div>
    </section>
  );
}
