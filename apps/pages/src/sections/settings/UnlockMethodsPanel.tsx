import { type FormEvent, useEffect, useState } from "react";
import { IconAlert, IconPasskey, IconShield } from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { estimateStrength } from "../../lib/vault/password.js";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  type WebauthnHostCheck,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  pinPolicyProblems,
} from "../../lib/vault/unlock-methods.js";

const ENROLL_PASSKEY_PARAM = "enroll-passkey";

export function UnlockMethodsPanel() {
  const { header, guest } = useVault();
  const store = useVaultStore();
  const methods = listAvailableUnlockMethods(header);
  const hasPasskey = Boolean(header?.unlocks?.passkey);
  const hasPin = Boolean(header?.unlocks?.pin);
  const hasPassword = Boolean(header?.wrap && header?.kdf);
  const hasTotp = Boolean(header?.unlocks?.totp);
  // A code can only guard a key. A guest session holds nothing wrapped to
  // disk, and a vault with a code but no passkey, PIN or password is one
  // nothing can open. So enrolling MFA on a keyless vault is a two-step
  // ceremony: set the key first, in the same row, then scan and confirm.
  const hasKey = !guest && methods.length > 0;

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
  const [totpCode, setTotpCode] = useState("");
  /**
   * Where the MFA ceremony is: `key` is the step a keyless vault takes first
   * (choose and set a passkey, PIN or password right here), `code` is the
   * scan-and-confirm step, `idle` is neither.
   */
  const [mfaStage, setMfaStage] = useState<"idle" | "key" | "code">("idle");
  const [webauthnHost, setWebauthnHost] = useState<WebauthnHostCheck>(() =>
    checkWebauthnHost(),
  );

  useEffect(() => {
    setWebauthnHost(checkWebauthnHost());
  }, []);

  // The moment step 1 produces a key, step 2 begins on its own: the person
  // asked for MFA, and setting the key was the prerequisite, not the goal.
  useEffect(() => {
    if (mfaStage !== "key" || !hasKey || busy) return;
    void run(async () => {
      const uri = await store.beginTotpEnrollment();
      setTotpCode("");
      setTotpUri(uri);
      setMfaStage("code");
    }, "Key set. Now scan the code with your authenticator and enter the code it shows.");
  }, [mfaStage, hasKey, busy, store]);

  useEffect(() => {
    if (hasPasskey || busy) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(ENROLL_PASSKEY_PARAM) !== "1") return;
    if (!checkWebauthnHost().ok) return;
    url.searchParams.delete(ENROLL_PASSKEY_PARAM);
    window.history.replaceState(null, "", url);
    void run(() => store.enrollPasskey(), "Passkey unlock enrolled.");
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
        text: describeWebauthnError(
          caught instanceof Error ? caught : "Unknown WebAuthn error",
        ),
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
    const url = new URL(check.fixUrl);
    url.searchParams.set(ENROLL_PASSKEY_PARAM, "1");
    window.location.assign(url);
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
    void run(
      async () => {
        await store.enrollPin(pin);
        setPin("");
        setPinConfirm("");
      },
      hasPin
        ? "PIN updated."
        : "PIN unlock enrolled. You can unlock with this PIN next time.",
    );
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

  const pinProblems = pinPolicyProblems(pin);
  const pinProblem = pin.length > 0 ? (pinProblems[0] ?? null) : null;
  const pinMismatch =
    pinConfirm.length > 0 && pin !== pinConfirm
      ? "The two PINs do not match."
      : null;
  const pinReady =
    pin.length > 0 && pinProblems.length === 0 && pin === pinConfirm;
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
        </div>
      </div>
      <div className="panel__body set__unlock">
        <StatusNote message={message} />

        <div className="set__unlock-row">
          <div>
            <h3>
              <IconPasskey size={16} /> Passkey
            </h3>
            {hasPasskey ? <p className="hint">Enrolled.</p> : null}
            {!hasPasskey && !webauthnHost.ok ? (
              <output className="note note--warn">
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
                    <>
                      {" "}
                      Use a DNS hostname (Tailscale MagicDNS, or localhost for
                      local dev).
                    </>
                  )}
                </span>
              </output>
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
            {hasPin ? <p className="hint">Enrolled.</p> : null}
          </div>
          <div className="set__unlock-actions">
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
                disabled={busy || !pinReady}
              >
                {hasPin ? "Change PIN" : "Enroll PIN"}
              </button>
            </form>
            {pinProblem ? (
              <p className="note note--err" aria-live="polite">
                <IconAlert size={16} /> {pinProblem}
              </p>
            ) : pinMismatch ? (
              <p className="note note--err" aria-live="polite">
                <IconAlert size={16} /> {pinMismatch}
              </p>
            ) : null}
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
            ) : null}
          </div>
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
                : "Optional second step after a passkey, PIN or password. The seed is sealed under the vault key, and MFA turns on only once a code from your app matches — a bad scan can never lock you out."}
            </p>
          </div>
          {hasTotp ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => {
                setTotpUri(null);
                setMfaStage("idle");
                void run(
                  () => store.removeTotp(),
                  "Authenticator MFA removed.",
                );
              }}
            >
              Remove MFA
            </button>
          ) : mfaStage !== "idle" ? null : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => {
                if (!hasKey) {
                  // Step 1 first: a code needs a key to guard. The forms above
                  // still work, but the person came here for MFA, so the key
                  // is asked for here and MFA follows without a second trip.
                  setMessage(null);
                  setMfaStage("key");
                  return;
                }
                void run(async () => {
                  const uri = await store.beginTotpEnrollment();
                  setTotpCode("");
                  setTotpUri(uri);
                  setMfaStage("code");
                }, "Scan the code with your authenticator, then enter the code it shows to turn MFA on.");
              }}
            >
              Enroll MFA
            </button>
          )}
        </div>

        {mfaStage === "key" && !hasKey ? (
          <div className="set__unlock-totp set__unlock-step">
            <div className="steps" aria-label="MFA enrollment steps">
              <div className="steps__seg is-now">
                <span className="steps__bar" />
                <span className="steps__label">1 · Set a key</span>
              </div>
              <div className="steps__seg">
                <span className="steps__bar" />
                <span className="steps__label">2 · Scan and confirm</span>
              </div>
            </div>
            <p className="hint">
              An authenticator code guards a key, and this vault has none yet
              {guest ? " — it is a guest session" : ""}. Set the one you will
              unlock with; the code is asked for after it.
            </p>
            <form
              className="set__unlock-form"
              aria-label="Set a PIN"
              onSubmit={enrollPinForm}
            >
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                placeholder="PIN"
                value={pin}
                maxLength={MAX_PIN_LENGTH}
                onChange={(e) => setPin(e.target.value)}
                aria-label="PIN for this vault"
              />
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                placeholder="Confirm"
                value={pinConfirm}
                maxLength={MAX_PIN_LENGTH}
                onChange={(e) => setPinConfirm(e.target.value)}
                aria-label="Confirm PIN for this vault"
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={busy || !pinReady}
              >
                Use a PIN
              </button>
            </form>
            {pinProblem ? (
              <p className="note note--err" aria-live="polite">
                <IconAlert size={16} /> {pinProblem}
              </p>
            ) : pinMismatch ? (
              <p className="note note--err" aria-live="polite">
                <IconAlert size={16} /> {pinMismatch}
              </p>
            ) : null}
            <form
              className="set__unlock-form"
              aria-label="Set a password"
              onSubmit={enrollPasswordForm}
            >
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="Master password for this vault"
              />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                aria-label="Confirm master password for this vault"
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={busy || !passwordOk}
              >
                Use a password
              </button>
            </form>
            <div className="actions">
              {webauthnHost.ok ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => store.enrollPasskey(),
                      "Passkey unlock enrolled.",
                    )
                  }
                >
                  <IconPasskey size={16} /> Use a passkey
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() => {
                  setMfaStage("idle");
                  setMessage(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {totpUri && !hasTotp ? (
          <form
            className="set__unlock-totp"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await store.confirmTotpEnrollment(totpCode);
                setTotpCode("");
                setTotpUri(null);
                setMfaStage("idle");
              }, "Authenticator MFA is on. Every unlock now asks for a code.");
            }}
          >
            <div className="steps" aria-label="MFA enrollment steps">
              <div className="steps__seg is-done">
                <span className="steps__bar" />
                <span className="steps__label">1 · Set a key</span>
              </div>
              <div className="steps__seg is-now">
                <span className="steps__bar" />
                <span className="steps__label">2 · Scan and confirm</span>
              </div>
            </div>
            <QrCode value={totpUri} label="Scan to add vault MFA" size={160} />
            <p className="hint">
              Scan with your authenticator, then enter the code it shows.
              Nothing is written until a code matches; the secret is not shown
              again after you leave Settings.
            </p>
            <code className="set__unlock-secret">{totpUri}</code>
            <div className="set__unlock-form">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                aria-label="Authenticator code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={busy || totpCode.replace(/\s/g, "").length < 6}
              >
                Turn on
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() => {
                  store.cancelTotpEnrollment();
                  setTotpCode("");
                  setTotpUri(null);
                  setMfaStage("idle");
                  setMessage(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}
