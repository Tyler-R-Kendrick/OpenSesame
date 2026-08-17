import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconPasskey,
  IconShield,
  IconVault,
} from "../components/Icons.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import {
  type UnlockMethodId,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  preferredUnlockMethod,
} from "../lib/vault/unlock-methods.js";
import "./unlock.css";

const STRENGTH_VARS = ["--s-0", "--s-1", "--s-2", "--s-3", "--s-4"] as const;

const METHOD_LABEL: Record<UnlockMethodId, string> = {
  passkey: "Passkey",
  pin: "PIN",
  password: "Password",
};

function StrengthMeter({ password }: { password: string }) {
  const strength = estimateStrength(password);
  const filled = password ? strength.score + 1 : 0;
  const color = `var(${STRENGTH_VARS[strength.score]})`;
  return (
    <div className="unlock__meter">
      <div className="unlock__track" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            style={index < filled ? { background: color } : undefined}
          />
        ))}
      </div>
      <p className="unlock__meter-row">
        <span className="unlock__meter-label" style={{ color }}>
          {password ? strength.label : "Enter a master password"}
        </span>
        <span className="unlock__bits">
          {password ? `≈${strength.bits} bits` : ""}
        </span>
      </p>
    </div>
  );
}

function useCountdown(until: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0,
  );
  useEffect(() => {
    if (!until) {
      setRemaining(0);
      return;
    }
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return remaining;
}

export function UnlockScreen() {
  const {
    status,
    header,
    lockedOutUntil,
    failedAttempts,
    durable,
    awaitingTotp,
  } = useVault();
  const store = useVaultStore();
  const firstRun = status === "empty";

  const methods = useMemo(() => listAvailableUnlockMethods(header), [header]);
  const [method, setMethod] = useState<UnlockMethodId | null>(null);
  const activeMethod =
    method && methods.includes(method) ? method : preferredUnlockMethod(header);
  // Show the method switcher whenever a non-password unlock exists (even alone),
  // or whenever there is more than one method. Password-only vaults stay simple.
  const showMethodTabs =
    !firstRun &&
    !awaitingTotp &&
    (methods.length > 1 ||
      methods.includes("passkey") ||
      methods.includes("pin"));
  const passwordOnlyUnlock =
    !firstRun &&
    !awaitingTotp &&
    methods.length === 1 &&
    methods[0] === "password";

  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [totp, setTotp] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hint, setHint] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);

  const lockedFor = useCountdown(lockedOutUntil);
  const passkeyAttempted = useRef(false);

  useEffect(() => {
    if (awaitingTotp) {
      totpRef.current?.focus();
      return;
    }
    if (activeMethod === "pin") pinRef.current?.focus();
    else if (activeMethod === "password" || firstRun)
      passwordRef.current?.focus();
  }, [firstRun, activeMethod, awaitingTotp]);

  // Prefer passkey silently: offer the platform prompt once when it is the
  // default method, so unlock is not password-shaped by default.
  useEffect(() => {
    if (activeMethod !== "passkey") {
      passkeyAttempted.current = false;
      return;
    }
    if (firstRun || awaitingTotp || lockedFor > 0 || passkeyAttempted.current) {
      return;
    }
    // Do not auto-prompt on an IP origin — Chrome fails with a useless
    // "invalid domain" error; show remediation instead.
    if (!checkWebauthnHost().ok) {
      return;
    }
    passkeyAttempted.current = true;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void store
      .unlockWithPasskey()
      .catch((caught) => {
        if (cancelled) return;
        setError(describeWebauthnError(caught));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [firstRun, awaitingTotp, activeMethod, lockedFor, store]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (firstRun) {
        if (password !== confirm) {
          throw new Error("The two entries do not match.");
        }
        await store.create(password, hint.trim() || undefined);
      } else if (awaitingTotp) {
        await store.confirmTotp(totp);
        setTotp("");
      } else if (activeMethod === "passkey") {
        await store.unlockWithPasskey();
      } else if (activeMethod === "pin") {
        await store.unlockWithPin(pin);
        setPin("");
      } else {
        await store.unlock(password);
        setPassword("");
      }
      setConfirm("");
    } catch (caught) {
      setError(
        activeMethod === "passkey" ||
          (caught instanceof Error && /invalid domain|SecurityError/i.test(caught.message))
          ? describeWebauthnError(caught)
          : caught instanceof Error
            ? caught.message
            : "Unlock failed.",
      );
      setPassword("");
      setPin("");
      setTotp("");
      if (awaitingTotp) totpRef.current?.focus();
      else if (activeMethod === "pin") pinRef.current?.focus();
      else passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const passkeyHost = checkWebauthnHost();

  const strength = estimateStrength(password);
  const createBlocked =
    password.length < 12 ||
    password !== confirm ||
    !accepted ||
    strength.score < 2;

  let unlockBlocked = true;
  if (awaitingTotp) unlockBlocked = totp.replace(/\s/g, "").length < 6;
  else if (activeMethod === "passkey") unlockBlocked = !passkeyHost.ok;
  else if (activeMethod === "pin") unlockBlocked = pin.length < 4;
  else unlockBlocked = !password;

  const disabled =
    busy || lockedFor > 0 || (firstRun ? createBlocked : unlockBlocked);

  const brandCopy = firstRun
    ? "Choose a master password to seal this device. You can add a passkey, PIN, or authenticator later in Settings."
    : awaitingTotp
      ? "Enter the code from your authenticator app to finish unlocking."
      : "Unlock with a passkey, PIN, or password — whichever you enrolled. The vault key is not stored; a reload asks again.";

  return (
    <div className="unlock">
      <form className="unlock__card" onSubmit={(e) => void onSubmit(e)}>
        <div className="unlock__brand">
          <span className="mark mark--lg" aria-hidden="true">
            <IconVault size={24} />
          </span>
          <h1>{firstRun ? "Seal this device" : "OpenSesame"}</h1>
          <p>{brandCopy}</p>
        </div>

        <div className="unlock__form">
          {showMethodTabs ? (
            <div
              className="unlock__methods"
              role="tablist"
              aria-label="Unlock method"
            >
              {methods.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeMethod === id}
                  className={
                    activeMethod === id
                      ? "unlock__method unlock__method--active"
                      : "unlock__method"
                  }
                  disabled={busy || lockedFor > 0}
                  onClick={() => {
                    setMethod(id);
                    setError(null);
                  }}
                >
                  {id === "passkey" ? (
                    <IconPasskey size={16} />
                  ) : id === "pin" ? (
                    <IconLock size={16} />
                  ) : (
                    <IconShield size={16} />
                  )}
                  {METHOD_LABEL[id]}
                </button>
              ))}
            </div>
          ) : null}

          {passwordOnlyUnlock ? (
            <p className="hint">
              {passkeyHost.ok ? (
                <>
                  No passkey unlock on this vault yet. After you unlock, open{" "}
                  <strong>Settings → Unlock methods</strong> and enroll a
                  passkey.
                </>
              ) : (
                <>
                  Passkey unlock needs a DNS hostname
                  {passkeyHost.fixUrl ? (
                    <>
                      {" "}
                      — open{" "}
                      <a href={passkeyHost.fixUrl}>localhost</a> (not a raw
                      IP), unlock, then enroll under Settings.
                    </>
                  ) : (
                    <> before it can be enrolled in Settings.</>
                  )}
                </>
              )}
            </p>
          ) : null}

          {awaitingTotp ? (
            <div className="field">
              <label htmlFor="unlock-totp">Authenticator code</label>
              <input
                id="unlock-totp"
                ref={totpRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totp}
                disabled={busy || lockedFor > 0}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="6-digit code"
              />
              <p className="hint">
                MFA is enrolled on this vault. Primary unlock succeeded —
                confirm with your authenticator.
              </p>
              <button
                type="button"
                className="unlock__switch"
                onClick={() => {
                  store.cancelTotpChallenge();
                  setTotp("");
                  setError(null);
                }}
              >
                Use a different unlock method
              </button>
            </div>
          ) : null}

          {!firstRun && !awaitingTotp && activeMethod === "passkey" ? (
            passkeyHost.ok ? (
              <p className="hint">
                Use your platform authenticator. The WebAuthn PRF extension
                unwraps the vault key — no password typed.
              </p>
            ) : (
              <output className="note note--warn" role="status">
                <span>
                  {passkeyHost.reason}
                  {passkeyHost.fixUrl ? (
                    <>
                      {" "}
                      <a href={passkeyHost.fixUrl}>Continue on localhost</a>{" "}
                      (same vault data), then unlock with passkey.
                    </>
                  ) : (
                    <> Open this app on a DNS hostname, then try again.</>
                  )}
                </span>
              </output>
            )
          ) : null}

          {!firstRun && !awaitingTotp && activeMethod === "pin" ? (
            <div className="field">
              <label htmlFor="unlock-pin">PIN</label>
              <input
                id="unlock-pin"
                ref={pinRef}
                type={reveal ? "text" : "password"}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={pin}
                disabled={busy || lockedFor > 0}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>
          ) : null}

          {(firstRun || (!awaitingTotp && activeMethod === "password")) && (
            <div className="field">
              <label htmlFor="master">
                {firstRun ? "Master password" : "Password"}
              </label>
              <div className="unlock__reveal">
                <input
                  id="master"
                  ref={passwordRef}
                  type={reveal ? "text" : "password"}
                  autoComplete={firstRun ? "new-password" : "current-password"}
                  value={password}
                  disabled={busy || lockedFor > 0}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby={firstRun ? "master-help" : undefined}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setReveal((value) => !value)}
                  aria-label={reveal ? "Hide password" : "Show password"}
                >
                  {reveal ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                </button>
              </div>
            </div>
          )}

          {firstRun ? (
            <>
              <StrengthMeter password={password} />
              <div className="field">
                <label htmlFor="confirm">Confirm master password</label>
                <input
                  id="confirm"
                  type={reveal ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  disabled={busy}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="hint">Reminder (optional)</label>
                <input
                  id="hint"
                  type="text"
                  value={hint}
                  maxLength={80}
                  placeholder="Something only you would understand"
                  onChange={(e) => setHint(e.target.value)}
                />
                <p className="hint">
                  Stored unencrypted beside the vault so it can be shown before
                  you unlock. Never put the password itself here.
                </p>
              </div>
              <div className="unlock__terms">
                <p id="master-help">
                  There is no recovery. The key exists only while this password
                  is in your head — forget it and the encrypted items on this
                  device are unreadable, by you and by us. Add a passkey or PIN
                  in Settings so you are not limited to typing a password.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  <span>I understand this vault cannot be recovered.</span>
                </label>
              </div>
            </>
          ) : header?.hint && activeMethod === "password" && !awaitingTotp ? (
            <p className="unlock__hint">
              <strong>Reminder:</strong> {header.hint}
            </p>
          ) : null}

          {!durable ? (
            <output className="note note--warn">
              <span>
                This browser gives this app no persistent storage, so the vault
                will be gone when the tab closes — private windows and some
                embedded browsers do this. Do not put your only copy of anything
                in here.
              </span>
            </output>
          ) : null}

          {error ? (
            <p className="note note--err" role="alert">
              <span>{error}</span>
            </p>
          ) : null}

          {lockedFor > 0 ? (
            <output className="note note--warn">
              <span>
                {failedAttempts} failed attempts. Try again in {lockedFor}s.
              </span>
            </output>
          ) : null}

          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={disabled}
            aria-busy={busy}
          >
            {activeMethod === "passkey" && !awaitingTotp && !firstRun ? (
              <IconPasskey size={18} />
            ) : (
              <IconLock size={18} />
            )}
            {busy
              ? firstRun
                ? "Deriving key…"
                : awaitingTotp
                  ? "Checking code…"
                  : activeMethod === "passkey"
                    ? "Waiting for passkey…"
                    : "Unlocking…"
              : firstRun
                ? "Seal this device"
                : awaitingTotp
                  ? "Confirm MFA"
                  : activeMethod === "passkey"
                    ? "Unlock with passkey"
                    : "Unlock"}
          </button>

          {firstRun && password.length > 0 && strength.score < 2 ? (
            <p className="hint">
              Aim for a passphrase of four or more unrelated words. This one
              would not survive an offline attack on the encrypted file.
            </p>
          ) : null}
        </div>

        <div className="unlock__foot">
          <p>
            {firstRun
              ? "600,000 PBKDF2-SHA256 iterations, AES-256-GCM. Human items stay on this device. Host connectors stay on the Host."
              : "The vault key lives in memory only. Locking or reloading discards it."}
          </p>
          {!firstRun ? (
            showReset ? (
              <div className="unlock__danger">
                <p>
                  Deleting removes the encrypted vault from this browser.
                  Without an enrolled unlock method its contents are already
                  unrecoverable — this only clears the file so you can start
                  again.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => void store.destroy()}
                  >
                    Delete this vault
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setShowReset(false)}
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="unlock__switch"
                onClick={() => setShowReset(true)}
              >
                Forgotten how to unlock?
              </button>
            )
          ) : null}
        </div>
      </form>
    </div>
  );
}
