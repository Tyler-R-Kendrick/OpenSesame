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
  IconVault,
} from "../components/Icons.js";
import {
  TRUSTED_UPSTREAMS,
  beginSignIn,
  defaultUpstream,
} from "../lib/federation.js";
import { continueAsGuest } from "../lib/guest-auth.js";
import {
  type OrgAuthMethod,
  type OrgTenant,
  lookupOrgTenant,
  orgAuthUpstream,
  routeOrgMethod,
} from "../lib/orgs.js";
import {
  type FederatedProviderSummary,
  brokeredOrgUpstream,
  brokeredRealmUpstream,
  brokeredUpstream,
  listFederatedProviders,
  requestEmailMagicLink,
  workEmailDomain,
} from "../lib/providers.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import {
  MIN_PIN_LENGTH,
  type UnlockMethodId,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  preferredUnlockMethod,
} from "../lib/vault/unlock-methods.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
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
  // Reads location.hostname, so it must be resolved at render, not at import:
  // loopback deployments get the local mock IdP, everything else the broker.
  const upstream = defaultUpstream();

  const methods = useMemo(() => {
    if (!firstRun) return listAvailableUnlockMethods(header);
    const available: UnlockMethodId[] = [];
    if (passkeyHost.ok) available.push("passkey");
    available.push("pin", "password");
    return available;
  }, [firstRun, header, passkeyHost.ok]);
  const [method, setMethod] = useState<UnlockMethodId | null>(null);
  const fallbackMethod: UnlockMethodId | null = firstRun
    ? passkeyHost.ok
      ? "passkey"
      : "password"
    : preferredUnlockMethod(header);
  const activeMethod =
    method && methods.includes(method) ? method : fallbackMethod;
  // Show the method switcher whenever a non-password unlock exists (even alone),
  // or whenever there is more than one method. Password-only vaults stay simple.
  const showMethodTabs =
    !awaitingTotp &&
    (firstRun ||
      methods.length > 1 ||
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
  const passkeyAbort = useRef<AbortController | null>(null);

  // First run offers whatever this deployment brokers (D7). An empty catalog —
  // no Identity API, an unreachable one, a deployment older than the endpoint —
  // is not an error state: it falls back to the single default upstream this
  // screen has always shown, because first run must never dead-end.
  const [providers, setProviders] = useState<FederatedProviderSummary[]>([]);
  const [orgSlug, setOrgSlug] = useState("");
  const [orgTenant, setOrgTenant] = useState<OrgTenant | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);
  const [workEmail, setWorkEmail] = useState("");
  const [workEmailError, setWorkEmailError] = useState<string | null>(null);
  const [linkEmail, setLinkEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!firstRun) return;
    let cancelled = false;
    void listFederatedProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, [firstRun]);

  /**
   * Every federated entry ends in a navigation, so success never comes back
   * here — only a failure gets to clear `busy` and say why.
   */
  const startFederated = useCallback(
    (run: () => Promise<void>, fallbackMessage: string) => {
      setError(null);
      setBusy(true);
      void run().catch((caught) => {
        setError(caught instanceof Error ? caught.message : fallbackMessage);
        setBusy(false);
      });
    },
    [],
  );

  function startProvider(provider: FederatedProviderSummary): void {
    // A browser-capable provider is one this tab can talk to directly — and it
    // still has to be in the compiled trust list to be started that way. The
    // catalog decides which buttons exist, never which issuers are trusted.
    const direct = provider.browserCapable
      ? TRUSTED_UPSTREAMS.find(
          (upstreamEntry) => upstreamEntry.id === provider.id,
        )
      : undefined;
    startFederated(
      () =>
        direct
          ? beginSignIn(direct, { returnTo: "/" })
          : beginSignIn(brokeredUpstream(provider), {
              providerHint: provider.id,
              returnTo: "/",
            }),
      "Sign-in failed.",
    );
  }

  async function findOrganization(): Promise<void> {
    setOrgError(null);
    setOrgTenant(null);
    setOrgBusy(true);
    try {
      setOrgTenant(await lookupOrgTenant(orgSlug));
    } catch (caught) {
      setOrgError(
        caught instanceof Error
          ? caught.message
          : "Could not find that organization.",
      );
    } finally {
      setOrgBusy(false);
    }
  }

  function startOrgMethod(tenant: OrgTenant, method: OrgAuthMethod): void {
    const route = routeOrgMethod(method);
    startFederated(
      () =>
        route.via === "brokered"
          ? // Native SAML and LDAP have no browser leg: the Identity API runs
            // the whole ceremony and hands this tab a session to adopt.
            beginSignIn(brokeredOrgUpstream(tenant), { returnTo: "/" })
          : beginSignIn(orgAuthUpstream(tenant, method), {
              orgSlug: tenant.slug,
              orgMethod: route.kind,
              returnTo: "/",
            }),
      "Could not start organization sign-in.",
    );
  }

  function continueWithWorkEmail(): void {
    const domain = workEmailDomain(workEmail);
    if (!domain) {
      setWorkEmailError("Enter your work email, like you@acme.com.");
      return;
    }
    setWorkEmailError(null);
    // Routing only (D12/T28): the domain goes to the login page as a standard
    // `login_hint`, and the address the human typed is dropped right here —
    // never stored, never sent, never logged.
    setWorkEmail("");
    startFederated(
      () =>
        beginSignIn(brokeredRealmUpstream(), {
          returnTo: "/",
          loginHint: domain,
        }),
      "Could not look up that organization.",
    );
  }

  async function sendMagicLink(): Promise<void> {
    setLinkError(null);
    setLinkBusy(true);
    try {
      // Unlike the discovery field above, this address is the identifier: the
      // link proves it, and the proven address becomes an identity (D18).
      await requestEmailMagicLink(linkEmail.trim());
      setLinkSent(true);
    } catch (caught) {
      setLinkError(
        caught instanceof Error
          ? caught.message
          : "Could not send the sign-in link.",
      );
    } finally {
      setLinkBusy(false);
    }
  }

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
    const controller = new AbortController();
    passkeyAbort.current = controller;
    setBusy(true);
    setError(null);
    void store
      .unlockWithPasskey(controller.signal)
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        setError(describeWebauthnError(caught));
      })
      .finally(() => {
        // Only the still-current ceremony clears busy — a newer one may
        // already have taken over.
        if (passkeyAbort.current === controller) {
          passkeyAbort.current = null;
          setBusy(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [firstRun, awaitingTotp, activeMethod, lockedFor, store]);

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
        activeMethod === "passkey" ||
          (caught instanceof Error &&
            /invalid domain|SecurityError/i.test(caught.message))
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
  const createBlocked =
    !accepted ||
    (activeMethod === "passkey"
      ? !passkeyHost.ok
      : activeMethod === "pin"
        ? pin.length < MIN_PIN_LENGTH || pin !== confirm
        : password.length < 12 || password !== confirm || strength.score < 2);

  let unlockBlocked = true;
  if (awaitingTotp) unlockBlocked = totp.replace(/\s/g, "").length < 6;
  else if (activeMethod === "passkey") unlockBlocked = !passkeyHost.ok;
  else if (activeMethod === "pin") unlockBlocked = pin.length < 4;
  else unlockBlocked = !password;

  const disabled =
    busy || lockedFor > 0 || (firstRun ? createBlocked : unlockBlocked);

  // ADR 0033 §4: first run asks who you are before it asks for a master
  // password. Both paths are offered plainly — sign in with a federated
  // account, or seal this device locally right now.
  const firstRunSealCopy =
    activeMethod === "passkey"
      ? "Or seal this device with a passkey. A password is optional — add one later in Settings if you want a typed backup."
      : activeMethod === "pin"
        ? "Or seal this device with a PIN. A password is optional — add one later in Settings if you want a typed backup."
        : "Or choose a master password to seal this device. You can add a passkey or PIN later in Settings.";

  const brandCopy = firstRun
    ? `Two ways in: sign in with ${providers.length > 0 ? "an account you already have" : upstream.accountKind} and this device opens with no passkey or password. ${firstRunSealCopy}`
    : awaitingTotp
      ? "Enter the code from your authenticator app to finish unlocking."
      : "Unlock with a passkey, PIN, or password — whichever you enrolled. The vault key is not stored; a reload asks again.";

  return (
    <div className="unlock">
      <form className="unlock__card" onSubmit={(e) => void onSubmit(e)}>
        <PendingLinkBanner />
        <UnconfiguredIdentityNotice />
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
                      — open <a href={passkeyHost.fixUrl}>localhost</a> (not a
                      raw IP), unlock, then enroll under Settings.
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

          {firstRun && activeMethod === "password" ? (
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
                  ? "There is no recovery. The vault key is wrapped by this device's passkey. Lose the authenticator and the encrypted items on this device are unreadable, by you and by us. A password is optional later in Settings."
                  : activeMethod === "pin"
                    ? "There is no recovery. The vault key is wrapped by this PIN. Forget it and the encrypted items on this device are unreadable, by you and by us. A password is optional later in Settings."
                    : "There is no recovery. The key exists only while this password is in your head — forget it and the encrypted items on this device are unreadable, by you and by us. Add a passkey or PIN in Settings so you are not limited to typing a password."}
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

          {firstRun ? (
            <>
              {providers.length > 0 ? (
                providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className="unlock__switch"
                    disabled={busy}
                    onClick={() => startProvider(provider)}
                  >
                    Sign in with {provider.label} — no passkey or password
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  className="unlock__switch"
                  disabled={busy}
                  onClick={() =>
                    startFederated(
                      () => beginSignIn(upstream, { returnTo: "/" }),
                      "Sign-in failed.",
                    )
                  }
                >
                  Sign in with {upstream.accountKind} — no passkey or password
                </button>
              )}

              <div className="field">
                <label htmlFor="unlock-org">Organization</label>
                <input
                  id="unlock-org"
                  type="text"
                  value={orgSlug}
                  placeholder="acme-corp"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => {
                    setOrgSlug(e.target.value);
                    setOrgTenant(null);
                    setOrgError(null);
                  }}
                />
                <button
                  type="button"
                  className="unlock__switch"
                  disabled={busy || orgBusy || orgSlug.trim().length < 2}
                  onClick={() => void findOrganization()}
                >
                  {orgBusy ? "Looking up…" : "Continue with your organization"}
                </button>
                {orgTenant ? (
                  orgTenant.authMethods.length === 0 ? (
                    <p className="hint">
                      {orgTenant.displayName} has not configured organization
                      sign-in yet.
                    </p>
                  ) : (
                    <>
                      <p className="hint">{orgTenant.displayName}</p>
                      {orgTenant.authMethods.map((method) => (
                        <button
                          key={method.kind}
                          type="button"
                          className="unlock__switch"
                          disabled={busy}
                          onClick={() => startOrgMethod(orgTenant, method)}
                        >
                          Continue with {method.label}
                        </button>
                      ))}
                    </>
                  )
                ) : null}
                {orgError ? <p className="hint">{orgError}</p> : null}
              </div>

              <div className="field">
                <label htmlFor="unlock-work-email">
                  Continue with your work email
                </label>
                <input
                  id="unlock-work-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={workEmail}
                  placeholder="you@acme.com"
                  disabled={busy}
                  onChange={(e) => {
                    setWorkEmail(e.target.value);
                    setWorkEmailError(null);
                  }}
                />
                <button
                  type="button"
                  className="unlock__switch"
                  disabled={busy || workEmail.trim().length === 0}
                  onClick={() => continueWithWorkEmail()}
                >
                  Find my organization
                </button>
                <p className="hint">
                  Only the domain is used, to find your organization. The
                  address is not stored or sent anywhere.
                </p>
                {workEmailError ? (
                  <p className="hint">{workEmailError}</p>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="unlock-link-email">Continue with email</label>
                <input
                  id="unlock-link-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={linkEmail}
                  placeholder="you@example.com"
                  disabled={busy || linkBusy || linkSent}
                  onChange={(e) => {
                    setLinkEmail(e.target.value);
                    setLinkError(null);
                  }}
                />
                <button
                  type="button"
                  className="unlock__switch"
                  disabled={
                    busy ||
                    linkBusy ||
                    linkSent ||
                    linkEmail.trim().length === 0
                  }
                  onClick={() => void sendMagicLink()}
                >
                  {linkBusy ? "Sending…" : "Email me a sign-in link"}
                </button>
                {linkSent ? (
                  <p className="hint">
                    Check your email for a sign-in link. It signs you in on this
                    device.
                  </p>
                ) : null}
                {linkError ? <p className="hint">{linkError}</p> : null}
              </div>

              <button
                type="button"
                className="unlock__switch"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setBusy(true);
                  void continueAsGuest()
                    .catch((caught) => {
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "Guest login failed.",
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Continue as guest — no passkey or password
              </button>
            </>
          ) : null}
        </div>

        <div className="unlock__foot">
          <p>
            {firstRun
              ? activeMethod === "password"
                ? "600,000 PBKDF2-SHA256 iterations, AES-256-GCM. Human items stay on this device. Host connectors stay on the Host."
                : "AES-256-GCM. Human items stay on this device. Host connectors stay on the Host."
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
