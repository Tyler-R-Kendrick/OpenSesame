import { briefOrigin } from "@opensesame/os-domain";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconArrowRight,
  IconAuthority,
  IconEye,
  IconEyeOff,
  IconLock,
  IconMark,
  IconPasskey,
  IconShield,
  IconUser,
} from "../components/Icons.js";
import { outcomeWantsSignIn, readAuthOutcome } from "../lib/auth-outcome.js";
import { defaultUpstream } from "../lib/federation.js";
import { continueAsGuest } from "../lib/guest-auth.js";
import {
  currentSession,
  identityBase,
  useIdentitySession,
} from "../lib/identity.js";
import { resumeStashedJoin } from "../lib/join-session.js";
import { PERSONAL_PROJECT_ID } from "../lib/projects.js";
import {
  type FederatedProviderSummary,
  listFederatedProviders,
} from "../lib/providers.js";
import { signOut, switchAccount } from "../lib/session-exit.js";
import { noWayIn, signInMethods } from "../lib/settings.js";
import { setupRequired, unlockViable } from "../lib/setup.js";
import { WrongPasswordError } from "../lib/vault/crypto.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { estimateStrength } from "../lib/vault/password.js";
import {
  MIN_PIN_LENGTH,
  type UnlockMethodId,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  pinPolicyProblems,
  preferredUnlockMethod,
} from "../lib/vault/unlock-methods.js";
import { deviceHasSeveralVaults, listDeviceVaults } from "../lib/vaults.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { SetupScreen } from "./SetupScreen.js";
import { VaultsScreen } from "./VaultsScreen.js";
import { AccountRow } from "./unlock/AccountRow.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
import { SignInPanel } from "./unlock/SignInPanel.js";
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

export const unlockScreenDependencies = {
  setupRequired,
  currentSession,
  identityBase,
  noWayIn,
  signInMethods,
  defaultUpstream,
  resumeStashedJoin,
  deviceHasSeveralVaults,
  listDeviceVaults,
};

/**
 * Setup comes before every other pre-vault screen.
 *
 * A device with no vault and no session cannot offer a working sign-in or a
 * vault to unlock, so the first visitor is asked to set this deployment up or
 * join an existing session — not shown two broken affordances and a warning.
 * Once the ceremony is answered — or it never applied, because a vault or a
 * session is already here — this is the unlock form and nothing else.
 *
 * The split exists so the early return happens above the form's hooks rather
 * than among them. The gate is re-read on every render: freezing it in
 * `useState` would skip the ceremony if the vault still looked sealed on the
 * first paint, and would keep a returning user in setup if a late hydrate then
 * found a vault.
 */
/**
 * Setup comes before every other pre-vault screen.
 *
 * A device with no vault and no session cannot offer a working sign-in or a
 * vault to unlock, so the first visitor is asked to set this deployment up or
 * join an existing session — not shown two broken affordances and a warning.
 * Once the ceremony is answered — or it never applied, because a vault or a
 * session is already here — this is the unlock form and nothing else.
 *
 * The split exists so the early return happens above the form's hooks rather
 * than among them. The gate is re-read on every render: freezing it in
 * `useState` would skip the ceremony if the vault still looked sealed on the
 * first paint, and would keep a returning user in setup if a late hydrate then
 * found a vault.
 */
export function UnlockScreen() {
  const { status } = useVault();
  const session = useIdentitySession();
  const [dismissed, setDismissed] = useState(false);
  const [forced, setForced] = useState(false);
  // A device holding more than one vault opens on the choice, not on
  // whichever tomb the boot pointer named (ADR 0089). One vault, no choice:
  // straight to its unlock form, as before.
  const [vaultsOpen, setVaultsOpen] = useState(() =>
    unlockScreenDependencies.deviceHasSeveralVaults(),
  );
  // Whatever this deployment brokers (D7), fetched once for both the front
  // door and the unlock form. An empty catalog — no Identity API, an
  // unreachable one, a deployment older than the endpoint — is not an error
  // state: SignInPanel falls back to the single default upstream.
  const [providers, setProviders] = useState<FederatedProviderSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listFederatedProviders()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {
        /* the empty catalog stands */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const required = unlockScreenDependencies.setupRequired({
    vaultStatus: status,
    hasSession: unlockScreenDependencies.currentSession() !== null,
  });
  const setupOpen = forced || (required && !dismissed);

  useEffect(() => {
    if (setupOpen || !session) return;
    void unlockScreenDependencies.resumeStashedJoin().catch(() => {
      // A spent or expired stash is not a reason to trap unlock. The next
      // invite is a new one.
    });
  }, [setupOpen, session]);

  if (setupOpen) {
    return (
      <SetupScreen
        intent={forced && !required ? "setup" : undefined}
        onDone={() => {
          setForced(false);
          setDismissed(true);
        }}
      />
    );
  }
  if (vaultsOpen) {
    return (
      <VaultsScreen
        providers={providers}
        onPicked={() => setVaultsOpen(false)}
      />
    );
  }
  return (
    <UnlockForm
      providers={providers}
      onOpenSetup={() => {
        setDismissed(false);
        setForced(true);
      }}
      onOpenVaults={() => setVaultsOpen(true)}
    />
  );
}

function UnlockForm({
  providers,
  onOpenSetup,
  onOpenVaults,
}: {
  providers: FederatedProviderSummary[];
  onOpenSetup: () => void;
  /** Back to the front door: every vault on this device (ADR 0089). */
  onOpenVaults: () => void;
}) {
  useSupportRoute("/unlock");
  const submitRef = useGuideTarget<HTMLButtonElement>("unlock.submit");
  const secretRef = useGuideTarget<HTMLInputElement>("unlock.secret");
  const passkeyRef = useGuideTarget<HTMLButtonElement>("unlock.passkey");
  const setupRef = useGuideTarget<HTMLButtonElement>("unlock.setup");
  const {
    status,
    tomb,
    header,
    lockedOutUntil,
    failedAttempts,
    durable,
    awaitingTotp,
  } = useVault();
  const store = useVaultStore();
  const firstRun = status === "empty";
  // Which vault this key opens, said in the prompt voice the rail uses once
  // inside — shown whenever there is a choice to go back to, or this is not
  // the personal vault (a project sealed a moment ago from the front door).
  const activeTomb = tomb ?? PERSONAL_PROJECT_ID;
  const vaultCrumb =
    unlockScreenDependencies.deviceHasSeveralVaults() ||
    activeTomb !== PERSONAL_PROJECT_ID
      ? (unlockScreenDependencies
          .listDeviceVaults()
          .find((vault) => vault.id === activeTomb)?.label ?? activeTomb)
      : null;
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
  // A sign-out, a switch or an "attach an account" from inside the app lands
  // here on purpose, so the tab it wanted is the one that opens.
  const [screenTab, setScreenTab] = useState<"unlock" | "signin">(() =>
    outcomeWantsSignIn(readAuthOutcome()) ? "signin" : "unlock",
  );
  // The Unlock tab is offered only where unlocking is an action this device
  // can actually perform — a sealed vault to open. It is withheld rather than
  // disabled: a greyed tab still asserts the action exists and merely is not
  // available right now, which is a different claim, and an untrue one when
  // nothing has ever been sealed here.
  const returningTabs = unlockViable(status) && !awaitingTotp;
  const signInTabActive = returningTabs && screenTab === "signin";
  // Not "no identity service" — the compiled-in broker and any provider the
  // operator brought run in this browser and need no service at all (ADR
  // 0078). This is the narrower and truer claim: setup left no way in.
  const nothingSignsIn = unlockScreenDependencies.noWayIn();
  /**
   * What this app is pointed at, said as the operator would say it: the
   * identity service where there is one, otherwise the provider that will
   * actually sign people in. "No identity service" was the old line, and it
   * read as broken on a deployment whose Google button worked fine.
   */
  const deploymentName = (() => {
    const service = unlockScreenDependencies.identityBase().trim();
    if (service) return briefOrigin(service);
    const configured = unlockScreenDependencies.signInMethods();
    const [first] = configured.providers;
    if (first) {
      const more = configured.providers.length - 1;
      return more > 0 ? `${first.label} +${more}` : first.label;
    }
    if (configured.builtin) {
      return unlockScreenDependencies.defaultUpstream().displayName;
    }
    return "No accounts";
  })();

  const methods = useMemo<UnlockMethodId[]>(() => {
    // A returning vault offers exactly the challenges it enrolled. The screen
    // used to show all three whatever the vault had, on the theory that which
    // ones exist is the person's own knowledge — but the header on disk is
    // plaintext and already says so, so hiding it protected nothing and cost
    // the person their own configuration: a PIN tab for a vault with no PIN,
    // and no sign of the authenticator code they set up.
    if (!firstRun) return listAvailableUnlockMethods(header);
    const available: UnlockMethodId[] = [];
    if (passkeyHost.ok) available.push("passkey");
    available.push("pin", "password");
    return available;
  }, [firstRun, header, passkeyHost.ok]);
  // A vault with an authenticator code but no passkey, PIN or password: a
  // code can only ever follow a key, so nothing here can open it. Said out
  // loud rather than drawn as three tabs that all fail.
  const noPrimary = !firstRun && methods.length === 0;
  // The second step, announced before the first is taken.
  const hasTotpStep = !firstRun && !noPrimary && Boolean(header?.unlocks?.totp);
  const [method, setMethod] = useState<UnlockMethodId | null>(null);
  const fallbackMethod: UnlockMethodId = firstRun
    ? passkeyHost.ok
      ? "passkey"
      : "password"
    : (preferredUnlockMethod(header) ?? "password");
  const activeMethod =
    method && methods.includes(method) ? method : fallbackMethod;
  const showMethodTabs = !awaitingTotp && !noPrimary;

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
  if (noPrimary) unlockBlocked = true;
  else if (awaitingTotp) unlockBlocked = totp.replace(/\s/g, "").length < 6;
  else if (activeMethod === "passkey") unlockBlocked = !passkeyHost.ok;
  else if (activeMethod === "pin") unlockBlocked = pin.length < 4;
  else unlockBlocked = !password;

  const disabled =
    busy || lockedFor > 0 || (firstRun ? createBlocked : unlockBlocked);

  return (
    <div className="unlock">
      <div className="unlock__card">
        <PendingLinkBanner />
        <div className="unlock__brand">
          <p className="unlock__wordmark">
            <IconMark size={16} />
            opensesame
          </p>
          <h1>
            {signInStage
              ? "Sign in"
              : firstRun
                ? "Seal this device"
                : awaitingTotp
                  ? "Confirm it is you"
                  : "Unlock"}
          </h1>
          {vaultCrumb ? (
            <p className="unlock__crumb">
              <button
                type="button"
                className="unlock__switch"
                onClick={onOpenVaults}
              >
                ‹ Vaults
              </button>
              <span className="prompt__dim" aria-hidden="true">
                /
              </span>
              <span className="unlock__crumb-tomb">{vaultCrumb}</span>
              <span className="prompt__dim" aria-hidden="true">
                :/
              </span>
            </p>
          ) : null}
        </div>

        {/* Who this device is signed in as, above both tabs: the account is a
            fact about the device, not the vault. Switch ends the session and
            arms a fresh sign-in; Sign out ends it and says so. */}
        <AccountRow
          disabled={busy}
          onSwitch={() => {
            cancelPasskeyCeremony();
            switchAccount();
            setError(null);
            setScreenTab("signin");
          }}
          onSignOut={() => {
            cancelPasskeyCeremony();
            signOut();
            setError(null);
            setScreenTab("signin");
          }}
        />

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

        {/* Setup left no way in at all: no broker, no provider, no identity
            service. The old screen reported a near-miss of this in a block of
            amber above every sign-in button, all of which still redirected
            into nothing. One sentence and the road that fixes it. */}
        {nothingSignsIn && (signInStage || signInTabActive) ? (
          <div className="note unlock__unset">
            <span>
              No way in is configured for this deployment yet, so sign-in has
              nowhere to go.
            </span>
            <button
              ref={setupRef}
              type="button"
              className="btn btn--sm"
              onClick={onOpenSetup}
            >
              Set it up
            </button>
          </div>
        ) : null}

        {signInStage ? (
          <GuideTarget id="unlock.signin">
            <SignInPanel
              placement="primary"
              providers={providers}
              onUseLocalOnly={() => setLocalOnly(true)}
            />
          </GuideTarget>
        ) : signInTabActive ? (
          <GuideTarget id="unlock.signin">
            <SignInPanel placement="secondary" providers={providers} />
          </GuideTarget>
        ) : (
          <form className="unlock__form" onSubmit={(e) => void onSubmit(e)}>
            {hasTotpStep ? (
              <div className="steps" aria-label="Unlock steps">
                <div
                  className={
                    awaitingTotp ? "steps__seg is-done" : "steps__seg is-now"
                  }
                >
                  <span className="steps__bar" />
                  <span className="steps__label">1 · Key</span>
                </div>
                <div
                  className={awaitingTotp ? "steps__seg is-now" : "steps__seg"}
                >
                  <span className="steps__bar" />
                  <span className="steps__label">2 · Authenticator code</span>
                </div>
              </div>
            ) : null}

            {noPrimary ? (
              <output className="note note--err">
                <span>
                  This vault has an authenticator code but no passkey, PIN or
                  password to open it with, so nothing here can unlock it.
                  Delete it and seal it again, or continue as a guest.
                </span>
              </output>
            ) : null}

            {showMethodTabs ? (
              <div
                className="unlock__methods"
                role="tablist"
                aria-label="Unlock method"
              >
                {methods.map((id) => (
                  <button
                    key={id}
                    ref={id === "passkey" ? passkeyRef : undefined}
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
                  The key was right. This vault also asks for the code your
                  authenticator app shows for OpenSesame.
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

            {(firstRun || !awaitingTotp) &&
            activeMethod === "passkey" &&
            !passkeyHost.ok ? (
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
            ) : null}

            {!awaitingTotp && activeMethod === "pin" ? (
              <div className="field">
                <label htmlFor="unlock-pin">
                  {firstRun ? "Device PIN" : "PIN"}
                </label>
                <input
                  id="unlock-pin"
                  ref={(element) => {
                    pinRef.current = element;
                    secretRef(element);
                  }}
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
                    ref={(element) => {
                      passwordRef.current = element;
                      secretRef(element);
                    }}
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

            {noPrimary
              ? null
              : (() => {
                  // The submit is the terminal's enter key: an ink square whose
                  // glyph is the ceremony, with the sentence in its name.
                  const verb = busy
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
                          : "Unlock";
                  return (
                    <div className="go-row">
                      <button
                        ref={submitRef}
                        type="submit"
                        className="go"
                        disabled={disabled}
                        aria-busy={busy}
                        aria-label={verb}
                        title={verb}
                      >
                        {activeMethod === "passkey" && !awaitingTotp ? (
                          <IconPasskey size={18} />
                        ) : (
                          <IconArrowRight size={18} />
                        )}
                      </button>
                      <span className="go-verb" aria-hidden="true">
                        {verb}
                      </span>
                    </div>
                  );
                })()}

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
          {firstRun && localOnly ? (
            <button
              type="button"
              className="unlock__switch"
              onClick={() => setLocalOnly(false)}
            >
              Sign in instead
            </button>
          ) : null}
          {/* The guest road on the Unlock tab itself: whoever holds this
              device without its key still gets in, as a guest in an isolated
              tomb, and the sealed vault stays exactly as it is. Never removed,
              never gated (AGENTS.md §5). */}
          {!firstRun && !signInTabActive && !showReset ? (
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
              Continue as guest
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

          {/* Where this app is pointed, and the way back into setup. Quiet,
              because on a working deployment it is a fact rather than a
              problem — the operator who needs it is looking for it. */}
          <p className="unlock__deployment">
            <IconAuthority size={14} />
            <span className="unlock__deployment-name">{deploymentName}</span>
            <button
              type="button"
              className="unlock__switch"
              onClick={onOpenSetup}
            >
              Deployment setup
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
