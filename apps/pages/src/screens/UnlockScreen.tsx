import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconVault,
} from "../components/Icons.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import "./unlock.css";

const STRENGTH_VARS = ["--s-0", "--s-1", "--s-2", "--s-3", "--s-4"] as const;

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
  const { status, header, lockedOutUntil, failedAttempts, durable } =
    useVault();
  const store = useVaultStore();
  const firstRun = status === "empty";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hint, setHint] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const lockedFor = useCountdown(lockedOutUntil);

  // biome-ignore lint/correctness/useExhaustiveDependencies: firstRun is the trigger — focus has to move back to the field when the screen swaps between create and unlock
  useEffect(() => {
    passwordRef.current?.focus();
  }, [firstRun]);

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
      } else {
        await store.unlock(password);
      }
      setPassword("");
      setConfirm("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unlock failed.");
      setPassword("");
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const strength = estimateStrength(password);
  const createBlocked =
    password.length < 12 ||
    password !== confirm ||
    !accepted ||
    strength.score < 2;
  const disabled =
    busy || lockedFor > 0 || (firstRun ? createBlocked : !password);

  return (
    <div className="unlock">
      <form className="unlock__card" onSubmit={(e) => void onSubmit(e)}>
        <div className="unlock__brand">
          <span className="mark mark--lg" aria-hidden="true">
            <IconVault size={24} />
          </span>
          <h1>{firstRun ? "Create your vault" : "OpenSesame"}</h1>
          <p>
            {firstRun
              ? "Your master password derives the key that encrypts every item. It is never sent anywhere and never stored."
              : "Unlock to decrypt this device's vault."}
          </p>
        </div>

        <div className="unlock__form">
          <div className="field">
            <label htmlFor="master">Master password</label>
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
                  device are unreadable, by you and by us.
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
          ) : header?.hint ? (
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
            <IconLock size={18} />
            {busy
              ? firstRun
                ? "Deriving key…"
                : "Unlocking…"
              : firstRun
                ? "Create vault"
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
              ? "600,000 PBKDF2-SHA256 iterations, AES-256-GCM. Everything stays on this device."
              : "Items are decrypted in memory only, and discarded when the vault locks."}
          </p>
          {!firstRun ? (
            showReset ? (
              <div className="unlock__danger">
                <p>
                  Deleting removes the encrypted vault from this browser.
                  Without the master password its contents are already
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
                Forgotten your master password?
              </button>
            )
          ) : null}
        </div>
      </form>
    </div>
  );
}
