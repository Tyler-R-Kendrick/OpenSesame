import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconPasskey,
  IconShield,
  IconUser,
  IconVault,
} from "../components/Icons.js";
import {
  type FederatedProviderSummary,
  listFederatedProviders,
} from "../lib/providers.js";
import { WrongPasswordError } from "../lib/vault/crypto.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import {
  MIN_PIN_LENGTH,
  type UnlockMethodId,
  checkWebauthnHost,
  describeWebauthnError,
  pinPolicyProblems,
} from "../lib/vault/unlock-methods.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
import { SignInPanel } from "./unlock/SignInPanel.js";
import { UnconfiguredIdentityNotice } from "./unlock/UnconfiguredIdentityNotice.js";
import "./unlock.css";

const STRENGTH_VARS = ["--s-0", "--s-1", "--s-2", "--s-3", "--s-4"] as const;

const METHOD_LABEL = {
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
  const passkeyHost = checkWebauthnHost();
  // First run leads with identity (ADR 0033 §4): sign-in is the default
  // stage, and the local seal form is the explicit "use without an account"
  // road — not a wall of fields competing with it.
  const [localOnly, setLocalOnly] = useState(false);
  const signInStage = firstRun && !localOnly;
  // A device that already has a vault gets two separate ceremonies behind
  // tabs — never one stacked form: "Unlock" is the simple
  // passkey/PIN/password challenge, "Sign in" is the federated ceremony
  // (a different user, or attaching an account). Only one is on screen at a
  // time. Mid-MFA there is no choice to offer: the code field is the screen.
  const [screenTab, setScreenTab] = useState<"unlock" | "signin">("unlock");
  const returningTabs = !firstRun && !awaitingTotp;
  const signInTabActive = returningTabs && screenTab === "signin";

  const methods = useMemo<UnlockMethodId[]>(() => {
    // A returning vault gets the same menu as every other vault: which
    // challenges are enrolled is the user's own knowledge, not something the
    // screen should enumerate for whoever is holding the device.
    if (!firstRun) return ["passkey", "pin", "password"];
    const available: UnlockMethodId[] = [];
    if (passkeyHost.ok) available.push("passkey");
    available.push("pin", "password");
    return available;
  }, [firstRun, passkeyHost.ok]);
  const [method, setMethod] = useState<UnlockMethodId | null>(null);
  // The default tab is uniform too — never shaped by what this vault uses.
  const fallbackMethod: UnlockMethodId =
    firstRun && !passkeyHost.ok ? "password" : "passkey";
  const activeMethod =
    method && methods.includes(method) ? method : fallbackMethod;
  const showMethodTabs = !awaitingTotp;

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
  const passkeyAbort = useRef<AbortController | null>(null);

  // Whatever this deployment brokers (D7), on both screens. An empty catalog —
  // no Identity API, an unreachable one, a deployment older than the endpoint —
  // is not an error state: SignInPanel falls back to the single default
  // upstream this screen has always shown, because neither screen may dead-end.
  const [providers, setProviders] = useState<FederatedProviderSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listFederatedProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Switching methods (or leaving the passkey tab) must cancel any pending
  // platform prompt — a blocking WebAuthn request must never hold the other
  // unlock modes hostage.
  const cancelPasskeyCeremony = useCallback(() => {
    if (!passkeyAbort.current) return;
    passkeyAbort.current.abort();
    passkeyAbort.current = null;
    setBusy(false);
  }, []);

  useEffect(() => {
    if (awaitingTotp) {
      totpRef.current?.focus();
      return;
    }
    if (activeMethod === "pin") pinRef.current?.focus();
    else if (activeMethod === "password") passwordRef.current?.focus();
  }, [activeMethod, awaitingTotp]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (firstRun) {
        if (activeMethod === "passkey") {
          const controller = new AbortController();
          passkeyAbort.current = controller;
          try {
            await store.createWithPasskey(controller.signal);
          } finally {
            if (passkeyAbort.current === controller)
              passkeyAbort.current = null;
          }
        } else if (activeMethod === "pin") {
          if (pin !== confirm) {
            throw new Error("The two entries do not match.");
          }
          await store.createWithPin(pin);
          setPin("");
        } else {
          if (password !== confirm) {
            throw new Error("The two entries do not match.");
          }
          await store.create(password, hint.trim() || undefined);
        }
      } else if (awaitingTotp) {
        await store.confirmTotp(totp);
        setTotp("");
      } else if (activeMethod === "passkey") {
        const controller = new AbortController();
        passkeyAbort.current = controller;
        try {
          await store.unlockWithPasskey(controller.signal);
        } finally {
          if (passkeyAbort.current === controller) passkeyAbort.current = null;
        }
      } else if (activeMethod === "pin") {
        await store.unlockWithPin(pin);
        setPin("");
      } else {
        await store.unlock(password);
        setPassword("");
      }
      setConfirm("");
    } catch (caught) {
      // A passkey abort comes from the user switching methods — not an error.
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return;
      }
      setError(
        // A wrong-or-unenrolled credential already says exactly what the
        // screen may say — WebAuthn remediation would invent a browser problem
        // that did not happen. The TOTP step is never a WebAuthn problem
        // either.
        caught instanceof WrongPasswordError
          ? caught.message
          : !awaitingTotp &&
              (activeMethod === "passkey" ||
                (caught instanceof Error &&
                  /invalid domain|SecurityError/i.test(caught.message)))
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

  const strength = estimateStrength(password);
  const pinProblems =
    firstRun && activeMethod === "pin" ? pinPolicyProblems(pin) : [];
  const pinProblem =
    activeMethod === "pin" && pin.length > 0 ? (pinProblems[0] ?? null) : null;
  const createBlocked =
    !accepted ||
    (activeMethod === "passkey"
      ? !passkeyHost.ok
      : activeMethod === "pin"
        ? pinProblems.length > 0 || pin !== confirm
        : password.length < 12 || password !== confirm || strength.score < 2);

  let unlockBlocked = true;
  if (awaitingTotp) unlockBlocked = totp.replace(/\s/g, "").length < 6;
  else if (activeMethod === "passkey") unlockBlocked = !passkeyHost.ok;
  else if (activeMethod === "pin") unlockBlocked = pin.length < 4;
  else unlockBlocked = !password;

  const disabled =
    busy || lockedFor > 0 || (firstRun ? createBlocked : unlockBlocked);

  // ADR 0033 §4: first run asks who you are before it asks for a master
  // password. The seal form appears only on the explicit local-only road.
  const firstRunSealCopy =
    activeMethod === "passkey"
      ? "Seal this device with a passkey. A password is optional — add one later in Settings if you want a typed backup."
      : activeMethod === "pin"
        ? "Seal this device with a PIN. A password is optional — add one later in Settings if you want a typed backup."
        : "Choose a master password to seal this device. You can add a passkey or PIN later in Settings.";

  const brandCopy = signInStage
    ? "Sign in to sync your vault across your devices — or keep everything on this one."
    : firstRun
      ? `Local-only vault: no account, no sync, no recovery. ${firstRunSealCopy}`
      : awaitingTotp
        ? "Enter the code from your authenticator app to finish unlocking."
        : signInTabActive
          ? "Sign in as a different user, or attach an account this device can sync through. The vault itself opens from the Unlock tab."
          : "Unlock with the challenge you enrolled — passkey, PIN, or password. The vault key is not stored; a reload asks again.";

  return (
    <div className="unlock">
      <div className="unlock__card">
        <PendingLinkBanner />
        <UnconfiguredIdentityNotice />
        <div className="unlock__brand">
          <span className="mark mark--lg" aria-hidden="true">
            <IconVault size={24} />
          </span>
          <h1>
            {signInStage
              ? "OpenSesame"
              : firstRun
                ? "Seal this device"
                : "OpenSesame"}
          </h1>
          <p>{brandCopy}</p>
        </div>

        {returningTabs ? (
          <div
            className="unlock__methods"
            role="tablist"
            aria-label="Unlock or sign in"
          >
            <button
              type="button"
              role="tab"
              aria-selected={screenTab === "unlock"}
              className={
                screenTab === "unlock"
                  ? "unlock__method unlock__method--active"
                  : "unlock__method"
              }
              onClick={() => {
                setScreenTab("unlock");
                setError(null);
              }}
            >
              <IconLock size={16} />
              Unlock
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={screenTab === "signin"}
              className={
                screenTab === "signin"
                  ? "unlock__method unlock__method--active"
                  : "unlock__method"
              }
              onClick={() => {
                // Leaving the unlock form must drop any pending platform
                // passkey prompt — one ceremony at a time.
                cancelPasskeyCeremony();
                setScreenTab("signin");
                setError(null);
              }}
            >
              <IconUser size={16} />
              Sign in
            </button>
          </div>
        ) : null}

        {signInStage ? (
          <SignInPanel
            placement="primary"
            providers={providers}
            onUseLocalOnly={() => setLocalOnly(true)}
          />
        ) : signInTabActive ? (
          <SignInPanel placement="secondary" providers={providers} />
        ) : (
          <form className="unlock__form" onSubmit={(e) => void onSubmit(e)}>
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
                    // Not gated on `busy`: switching methods is exactly how you
                    // escape a blocking passkey prompt, so the tabs must stay
                    // live while a ceremony is pending.
                    disabled={lockedFor > 0}
                    onClick={() => {
                      cancelPasskeyCeremony();
                      setMethod(id);
                      setError(null);
                      setConfirm("");
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

            {(firstRun || !awaitingTotp) && activeMethod === "passkey" ? (
              passkeyHost.ok ? (
                <p className="hint">
                  Use your platform authenticator. The WebAuthn PRF extension
                  unwraps the vault key — no password typed.
                </p>
              ) : (
                <output className="note note--warn">
                  <span>
                    {passkeyHost.reason}
                    {passkeyHost.fixUrl ? (
                      <>
                        {" "}
                        {/* A button, same as the Settings twin's healPasskeyHost
                            — the unlock screen was the one auth surface still
                            repairing its environment through a raw anchor. */}
                        <button
                          type="button"
                          className="unlock__switch"
                          onClick={() =>
                            window.location.assign(passkeyHost.fixUrl ?? "")
                          }
                        >
                          Continue on localhost
                        </button>{" "}
                        (same vault data), then unlock with passkey.
                      </>
                    ) : (
                      <> Open this app on a DNS hostname, then try again.</>
                    )}
                  </span>
                </output>
              )
            ) : null}

            {!awaitingTotp && activeMethod === "pin" ? (
              <div className="field">
                <label htmlFor="unlock-pin">
                  {firstRun ? "Device PIN" : "PIN"}
                </label>
                <input
                  id="unlock-pin"
                  ref={pinRef}
                  type={reveal ? "text" : "password"}
                  inputMode="numeric"
                  autoComplete={firstRun ? "new-password" : "one-time-code"}
                  value={pin}
                  disabled={busy || lockedFor > 0}
                  onChange={(e) => setPin(e.target.value)}
                />
                {firstRun ? (
                  <p className="hint">
                    {MIN_PIN_LENGTH}–12 characters · no repeated character · no
                    sequential digits.
                  </p>
                ) : null}
                {pinProblem ? (
                  <p className="note note--err" aria-live="polite">
                    {pinProblem}
                  </p>
                ) : null}
              </div>
            ) : null}

            {!awaitingTotp && activeMethod === "password" && (
              <div className="field">
                <label htmlFor="master">
                  {firstRun ? "Master password" : "Password"}
                </label>
                <div className="unlock__reveal">
                  <input
                    id="master"
                    ref={passwordRef}
                    type={reveal ? "text" : "password"}
                    autoComplete={
                      firstRun ? "new-password" : "current-password"
                    }
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

            {firstRun && activeMethod === "password" ? (
              <>
                {/* Nothing to judge before anything is typed — a meter with a
                    red "enter a password" under a pristine field reads as an
                    error the person hasn't earned yet. */}
                {password.length > 0 ? (
                  <StrengthMeter password={password} />
                ) : null}
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
                <details className="unlock__optional">
                  <summary>Add an unlock reminder (optional)</summary>
                  <div className="field">
                    <input
                      id="hint"
                      type="text"
                      value={hint}
                      maxLength={80}
                      aria-label="Reminder"
                      placeholder="Something only you would understand"
                      onChange={(e) => setHint(e.target.value)}
                    />
                    <p className="hint">
                      Stored unencrypted beside the vault so it can be shown
                      before you unlock. Never put the password itself here.
                    </p>
                  </div>
                </details>
              </>
            ) : null}

            {firstRun && activeMethod === "pin" ? (
              <div className="field">
                <label htmlFor="confirm">Confirm PIN</label>
                <input
                  id="confirm"
                  type={reveal ? "text" : "password"}
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={confirm}
                  disabled={busy}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            ) : null}

            {firstRun ? (
              <div className="unlock__terms">
                <p id="master-help">
                  {activeMethod === "passkey"
                    ? "There is no recovery. Lose this device's authenticator and the encrypted items on this device are unreadable — by you and by us."
                    : activeMethod === "pin"
                      ? "There is no recovery. Forget this PIN and the encrypted items on this device are unreadable — by you and by us."
                      : "There is no recovery. Forget this password and the encrypted items on this device are unreadable — by you and by us."}
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
            ) : header?.hint && activeMethod === "password" && !awaitingTotp ? (
              <p className="unlock__hint">
                <strong>Reminder:</strong> {header.hint}
              </p>
            ) : null}

            {!durable ? (
              <output className="note note--warn">
                <span>
                  This browser gives this app no persistent storage, so the
                  vault will be gone when the tab closes — private windows and
                  some embedded browsers do this. Do not put your only copy of
                  anything in here.
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
              {activeMethod === "passkey" && !awaitingTotp ? (
                <IconPasskey size={18} />
              ) : (
                <IconLock size={18} />
              )}
              {busy
                ? firstRun
                  ? activeMethod === "passkey"
                    ? "Waiting for passkey…"
                    : activeMethod === "pin"
                      ? "Sealing…"
                      : "Deriving key…"
                  : awaitingTotp
                    ? "Checking code…"
                    : activeMethod === "passkey"
                      ? "Waiting for passkey…"
                      : "Unlocking…"
                : firstRun
                  ? activeMethod === "passkey"
                    ? "Seal with passkey"
                    : activeMethod === "pin"
                      ? "Seal with PIN"
                      : "Seal this device"
                  : awaitingTotp
                    ? "Confirm MFA"
                    : activeMethod === "passkey"
                      ? "Unlock with passkey"
                      : "Unlock"}
            </button>

            {firstRun &&
            activeMethod === "password" &&
            password.length > 0 &&
            strength.score < 2 ? (
              <p className="hint">
                Aim for a passphrase of four or more unrelated words. This one
                would not survive an offline attack on the encrypted file.
              </p>
            ) : null}
          </form>
        )}

        <div className="unlock__foot">
          {signInStage ? (
            <p>
              Signing in never uploads your vault items. It only attaches an
              identity your devices can sync through.
            </p>
          ) : (
            <p>
              {firstRun
                ? activeMethod === "password"
                  ? "600,000 PBKDF2-SHA256 iterations, AES-256-GCM. Human items stay on this device. Host connectors stay on the Host."
                  : "AES-256-GCM. Human items stay on this device. Host connectors stay on the Host."
                : "The vault key lives in memory only. Locking or reloading discards it."}
            </p>
          )}
          {firstRun && localOnly ? (
            <button
              type="button"
              className="unlock__switch"
              onClick={() => setLocalOnly(false)}
            >
              Sign in instead
            </button>
          ) : null}
          {!firstRun && !signInTabActive ? (
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
      </div>
    </div>
  );
}
