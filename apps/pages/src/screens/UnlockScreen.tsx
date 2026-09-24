import {
  outcomeWantsSignIn,
  readAuthOutcome,
} from "@opensesame/app-core/lib/auth-outcome.js";
import { resumeGuestSession } from "@opensesame/app-core/lib/guest-auth.js";
import { currentSession } from "@opensesame/app-core/lib/identity.js";
import { PERSONAL_PROJECT_ID } from "@opensesame/app-core/lib/projects.js";
import type { FederatedProviderSummary } from "@opensesame/app-core/lib/providers.js";
import { noWayIn } from "@opensesame/app-core/lib/settings.js";
import { loadSetup, unlockViable } from "@opensesame/app-core/lib/setup.js";
import { estimateStrength } from "@opensesame/app-core/lib/vault/password.js";
import type { SentCode } from "@opensesame/app-core/lib/vault/remote-code.js";
import { GUEST_TOMB } from "@opensesame/app-core/lib/vault/store.js";
import {
  MIN_PIN_LENGTH,
  type SecondStepId,
  type UnlockMethodId,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  listSecondSteps,
  pinPolicyProblems,
  preferredUnlockMethod,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  type DeviceVault,
  deviceHasSeveralVaults,
  listDeviceVaults,
  switchVault,
} from "@opensesame/app-core/lib/vaults.js";
import { cancelPasskeyDuressCode } from "@opensesame/app-core/screens/unlock/unlock-passkey-duress.js";
import { WrongPasswordError } from "@opensesame/vault-core";
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
  IconEye,
  IconEyeOff,
  IconLock,
  IconMail,
  IconMessage,
  IconPasskey,
  IconPhone,
  IconShield,
  IconX,
} from "../components/Icons.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { Wordmark } from "../components/Wordmark.js";
import { checkForAppUpdate } from "../lib/pwa-update.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { FrontDoor } from "./FrontDoor.js";
import { SetupScreen, type SetupStep } from "./SetupScreen.js";
import { VaultsScreen } from "./VaultsScreen.js";
import { RequirementsGate } from "./capabilities/RequirementsGate.js";
import { useJoinRoad } from "./join/JoinRoad.js";
import { CodeField } from "./unlock/CodeField.js";
import { GuestUnlockSwitch } from "./unlock/GuestRoad.js";
import { NoPrimaryNote } from "./unlock/NoPrimaryNote.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
import { ReleaseNotes } from "./unlock/ReleaseNotes.js";
import { SignInPanel } from "./unlock/SignInPanel.js";
import { StrengthMeter } from "./unlock/StrengthMeter.js";
import { UnlockUserMenu } from "./unlock/UnlockUserMenu.js";
import {
  METHOD_LABEL,
  RESEND_COOLDOWN_MS,
  SECOND_STEP_LABEL,
  unlockGoVerb,
} from "./unlock/labels.js";
import { useUnlockFormFocus } from "./unlock/unlock-form-focus.js";
import { submitUnlockForm } from "./unlock/unlock-form-submit.js";
import { useFederatedProviders } from "./unlock/use-federated-providers.js";
import { useCountdown } from "./unlock/useCountdown.js";
import "./unlock.css";

export const unlockScreenDependencies = {
  currentSession,
  loadSetup,
  noWayIn,
  deviceHasSeveralVaults,
  listDeviceVaults,
};

/**
 * Sign-in is the first screen, and nothing gates it (ADR 0090). The front
 * door offers setup and joining beside it, an invite link opens join itself
 * (ADR 0136), and a managed instance's required roots sit beside sign-in.
 */
export function UnlockScreen() {
  const { status, tomb } = useVault();
  const [ceremony, setCeremony] = useState<{
    step?: SetupStep;
    join?: boolean;
  } | null>(null);
  // Several vaults open on the choice (ADR 0089); one goes straight to it.
  const [vaultsOpen, setVaultsOpen] = useState(() =>
    unlockScreenDependencies.deviceHasSeveralVaults(),
  );
  const providers = useFederatedProviders();
  const join = useJoinRoad();
  // A locked screen is idle time: ask the service worker for a newer shell.
  useEffect(() => {
    void checkForAppUpdate();
  }, []);
  // The front door (ADR 0115): no vault and no setup record. The local-only
  // seal, a join, and an answered or skipped ceremony retire it; guest
  // prepare leaves status empty (no wrap on disk), which is Unlock.
  const [localOnlyPicked, setLocalOnlyPicked] = useState(false);
  const frontDoor =
    status === "empty" &&
    tomb !== GUEST_TOMB &&
    !localOnlyPicked &&
    unlockScreenDependencies.loadSetup() === null;

  if (join.screen) return join.screen;
  if (ceremony) {
    return (
      <SetupScreen
        step={ceremony.step}
        join={ceremony.join}
        onDone={() => setCeremony(null)}
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
  if (frontDoor) {
    return (
      <FrontDoor
        providers={providers}
        onOpenSetup={(join) => setCeremony({ step: undefined, join })}
        onOpenJoin={join.open}
        onUseLocalOnly={() => setLocalOnlyPicked(true)}
      />
    );
  }
  return (
    <UnlockForm
      providers={providers}
      initialLocalOnly={localOnlyPicked}
      onSignInInstead={
        localOnlyPicked ? () => setLocalOnlyPicked(false) : undefined
      }
      onOpenSetup={(step, join) => setCeremony({ step, join })}
      onOpenVaults={() => setVaultsOpen(true)}
    />
  );
}

function UnlockForm({
  providers,
  initialLocalOnly = false,
  onSignInInstead,
  onOpenSetup,
  onOpenVaults,
}: {
  providers: FederatedProviderSummary[];
  /** Arrive on the local-only seal form — the front door's third road. */
  initialLocalOnly?: boolean;
  /** Where "Sign in instead" goes when the front door is what sign-in is. */
  onSignInInstead?: () => void;
  onOpenSetup: (step?: SetupStep, join?: boolean) => void;
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
    awaitingSecondStep,
  } = useVault();
  const store = useVaultStore();
  const activeTomb = tomb ?? PERSONAL_PROJECT_ID;
  // The guest tomb is isolated, not keyless: a guest may enroll a gate (ADR
  // 0091) and those wraps are the key to this tomb. What makes the road guest
  // is the tomb, so nothing below is gated on it (AGENTS.md §5).
  const guestUnlock = activeTomb === GUEST_TOMB && status !== "unlocked";
  const firstRun = status === "empty" && !guestUnlock;
  // Which vault this key opens — shown whenever there is a choice to go back to, or this is not the personal vault.
  const vaultCrumb =
    unlockScreenDependencies.deviceHasSeveralVaults() ||
    activeTomb !== PERSONAL_PROJECT_ID
      ? (unlockScreenDependencies
          .listDeviceVaults()
          .find((vault) => vault.id === activeTomb)?.label ?? activeTomb)
      : null;
  const passkeyHost = checkWebauthnHost();
  // First run leads with identity (ADR 0033 §4): sign-in is the default stage, the local seal form the explicit road.
  const [localOnly, setLocalOnly] = useState(initialLocalOnly);
  const signInStage = firstRun && !localOnly;
  // A returning vault shows the key ceremony; sign-in lives in the user menu. Mid-MFA the code field is the screen.
  const [signingIn, setSigningIn] = useState(() =>
    outcomeWantsSignIn(readAuthOutcome()),
  );
  const returning = unlockViable(status) && !awaitingSecondStep;
  const showSignIn = returning && signingIn;
  // Not "no identity service" (ADR 0078) — the narrower and truer claim: setup left no way in.
  const nothingSignsIn = unlockScreenDependencies.noWayIn();

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
  // A guest tomb that enrolled no key at all: guest entry itself is the road
  // in, and the commit says so rather than pretending to unlock something.
  const guestKeyless = guestUnlock && methods.length === 0;
  // A vault with an authenticator code but no passkey, PIN or password: a
  // code can only ever follow a key, so nothing here can open it. Said out
  // loud rather than drawn as three tabs that all fail. A guest tomb with no
  // key is not that case — it has the guest road, and `guestKeyless` is it.
  const noPrimary = !firstRun && !guestUnlock && methods.length === 0;
  // The second step, announced before the first is taken.
  // Exactly the second steps this vault enrolled — authenticator, email,
  // text — offered at step 2 in the same tab vocabulary step 1 uses for keys.
  const secondSteps = firstRun ? [] : listSecondSteps(header);
  const hasTotpStep = !firstRun && !noPrimary && secondSteps.length > 0;
  const [method, setMethod] = useState<UnlockMethodId | null>(null);
  const [awaitingPasskeyDuressCode, setAwaitingPasskeyDuressCode] =
    useState(false);
  const fallbackMethod: UnlockMethodId = firstRun
    ? passkeyHost.ok
      ? "passkey"
      : "password"
    : (preferredUnlockMethod(header) ?? "password");
  const activeMethod =
    method && methods.includes(method) ? method : fallbackMethod;
  const showMethodTabs =
    !awaitingSecondStep &&
    !awaitingPasskeyDuressCode &&
    !noPrimary &&
    methods.length > 0;
  // A field is drawn only for a method this vault actually enrolled — the
  // fallback resolves to "password" with no wraps, and that could only fail.
  // The duress code reuses the PIN field after a passkey unlock.
  const showsPrimaryField =
    !awaitingSecondStep && methods.includes(activeMethod);
  const showsPinField =
    !awaitingSecondStep &&
    (awaitingPasskeyDuressCode ||
      (showsPrimaryField && activeMethod === "pin"));

  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [totp, setTotp] = useState("");
  const [secondStep, setSecondStep] = useState<SecondStepId | null>(null);
  const activeSecondStep: SecondStepId =
    secondStep && secondSteps.includes(secondStep)
      ? secondStep
      : (secondSteps[0] ?? "totp");
  // A code by email or text is sent the moment that tab is picked, once;
  // "Send it again" clears the mark and a fresh one goes out.
  const [sent, setSent] = useState<SentCode | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const requestedFor = useRef<SecondStepId | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recovery, setRecovery] = useState("");
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
  const goRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const acceptRef = useRef<HTMLInputElement>(null);

  const lockedFor = useCountdown(lockedOutUntil);
  const passkeyAbort = useRef<AbortController | null>(null);

  // Switching methods (or leaving the passkey tab) must cancel any pending
  // platform prompt — a blocking WebAuthn request must never hold the other
  // unlock modes hostage.
  const cancelPasskeyCeremony = useCallback(() => {
    if (passkeyAbort.current) {
      passkeyAbort.current.abort();
      passkeyAbort.current = null;
    }
    cancelPasskeyDuressCode();
    setAwaitingPasskeyDuressCode(false);
    setBusy(false);
  }, []);

  const formGated = lockedFor > 0;
  useUnlockFormFocus({
    signInStage,
    showSignIn,
    formGated,
    awaitingSecondStep,
    awaitingPasskeyDuressCode,
    guestKeyless,
    activeMethod,
    status,
    totpRef,
    pinRef,
    passwordRef,
    goRef,
    acceptRef,
    formRef,
  });

  const resendIn = useCountdown(
    sentAt === null ? null : sentAt + RESEND_COOLDOWN_MS,
  );

  useEffect(() => {
    if (!awaitingSecondStep) {
      requestedFor.current = null;
      setSent(null);
      setSentAt(null);
      setRecoveryMode(false);
      setRecovery("");
      return;
    }
    if (activeSecondStep === "totp" || recoveryMode) return;
    if (requestedFor.current === activeSecondStep) return;
    requestedFor.current = activeSecondStep;
    let live = true;
    setSent(null);
    setBusy(true);
    store.requestSecondStepCode(activeSecondStep).then(
      (result) => {
        if (!live) return;
        setSent(result);
        setSentAt(Date.now());
        setBusy(false);
      },
      (caught) => {
        if (!live) return;
        setError(
          caught instanceof Error ? caught.message : "The code was not sent.",
        );
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
  }, [awaitingSecondStep, activeSecondStep, recoveryMode, store]);

  function onSubmit(event: FormEvent) {
    void submitUnlockForm({
      event,
      busy,
      setBusy,
      setError,
      firstRun,
      guestKeyless,
      awaitingSecondStep,
      awaitingPasskeyDuressCode,
      setAwaitingPasskeyDuressCode,
      recoveryMode,
      activeMethod,
      activeSecondStep,
      store,
      passkeyAbort,
      pin,
      confirm,
      password,
      hint,
      recovery,
      totp,
      setPin,
      setConfirm,
      setPassword,
      setRecovery,
      setTotp,
      pinRef,
      passwordRef,
      totpRef,
    });
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
  if (guestKeyless) unlockBlocked = false;
  else if (noPrimary) unlockBlocked = true;
  else if (awaitingSecondStep)
    unlockBlocked = recoveryMode
      ? recovery.replace(/[^a-z0-9]/gi, "").length < 8
      : totp.replace(/\s/g, "").length < 6;
  else if (awaitingPasskeyDuressCode) unlockBlocked = pin.length < 4;
  else if (activeMethod === "passkey") unlockBlocked = !passkeyHost.ok;
  else if (activeMethod === "pin") unlockBlocked = pin.length < 4;
  else unlockBlocked = !password;

  const disabled =
    busy || lockedFor > 0 || (firstRun ? createBlocked : unlockBlocked);
  const goVerb = unlockGoVerb({
    busy,
    firstRun,
    awaitingSecondStep,
    awaitingPasskeyDuressCode,
    guestUnlock,
    activeMethod,
  });

  return (
    <div className="unlock">
      <div className="unlock__card">
        <PendingLinkBanner />
        <div className="unlock__brand">
          <Wordmark className="unlock__wordmark" size={28} replay />
          <div className="unlock__brand-tools">
            <ThemeToggle />
          </div>
        </div>
        <div className="unlock__heading">
          <h1 className="unlock__title">
            {signInStage || showSignIn
              ? "Sign in"
              : firstRun
                ? "Seal this device"
                : awaitingSecondStep
                  ? "Confirm it is you"
                  : "Unlock"}
          </h1>
          {!firstRun ? (
            <UnlockUserMenu
              disabled={busy}
              currentVaultId={activeTomb}
              signingIn={showSignIn}
              showAllVaults={vaultCrumb !== null}
              onOpenVaults={onOpenVaults}
              onSignIn={() => {
                cancelPasskeyCeremony();
                if (awaitingSecondStep) store.cancelTotpChallenge();
                setError(null);
                setSigningIn(true);
              }}
              onUnlock={() => {
                setError(null);
                setSigningIn(false);
              }}
              onPickVault={(vault: DeviceVault) => {
                cancelPasskeyCeremony();
                setError(null);
                setBusy(true);
                void switchVault(vault.id)
                  .then(() => setSigningIn(false))
                  .catch((caught) => {
                    setError(
                      caught instanceof Error
                        ? caught.message
                        : "Could not switch vault.",
                    );
                  })
                  .finally(() => setBusy(false));
              }}
            />
          ) : null}
        </div>

        <RequirementsGate
          onOpenSetup={(join) => onOpenSetup("capabilities", join)}
        />
        {/* Setup left no way in: one sentence and the road that fixes it. */}
        {nothingSignsIn && (signInStage || showSignIn) ? (
          <div className="note unlock__unset">
            <span>
              No way in is configured for this deployment yet, so sign-in has
              nowhere to go.
            </span>
            <button
              ref={setupRef}
              type="button"
              className="btn btn--sm"
              onClick={() => onOpenSetup("identity")}
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
        ) : showSignIn ? (
          <GuideTarget id="unlock.signin">
            <SignInPanel placement="secondary" providers={providers} />
          </GuideTarget>
        ) : (
          <form
            className="unlock__form"
            ref={formRef}
            onSubmit={(e) => void onSubmit(e)}
          >
            {hasTotpStep ? (
              <div className="steps" aria-label="Unlock steps">
                <div
                  className={
                    awaitingSecondStep
                      ? "steps__seg is-done"
                      : "steps__seg is-now"
                  }
                >
                  <span className="steps__bar" />
                  <span className="steps__label">1 · Key</span>
                </div>
                <div
                  className={
                    awaitingSecondStep ? "steps__seg is-now" : "steps__seg"
                  }
                >
                  <span className="steps__bar" />
                  <span className="steps__label">
                    {secondSteps.length === 1 && secondSteps[0] === "totp"
                      ? "2 · Authenticator code"
                      : "2 · Code"}
                  </span>
                </div>
              </div>
            ) : null}

            {noPrimary ? <NoPrimaryNote /> : null}

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

            {awaitingSecondStep ? (
              <>
                {secondSteps.length > 1 && !recoveryMode ? (
                  <div
                    className="unlock__methods"
                    role="tablist"
                    aria-label="Second step"
                  >
                    {secondSteps.map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={activeSecondStep === id}
                        className={
                          activeSecondStep === id
                            ? "unlock__method unlock__method--active"
                            : "unlock__method"
                        }
                        disabled={lockedFor > 0}
                        onClick={() => {
                          setSecondStep(id);
                          setTotp("");
                          setError(null);
                        }}
                      >
                        {id === "totp" ? (
                          <IconPhone size={16} />
                        ) : id === "email" ? (
                          <IconMail size={16} />
                        ) : (
                          <IconMessage size={16} />
                        )}
                        {SECOND_STEP_LABEL[id]}
                      </button>
                    ))}
                  </div>
                ) : null}

                {recoveryMode ? (
                  <div className="field">
                    <label htmlFor="unlock-recovery">Recovery code</label>
                    <input
                      id="unlock-recovery"
                      ref={totpRef}
                      type="text"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={recovery}
                      disabled={busy || lockedFor > 0}
                      onChange={(e) => setRecovery(e.target.value)}
                      placeholder="xxxx-xxxx"
                    />
                    <p className="hint">
                      One of the codes you saved. It opens the vault once, then
                      it is spent.
                    </p>
                    <button
                      type="button"
                      className="unlock__switch"
                      onClick={() => {
                        setRecoveryMode(false);
                        setRecovery("");
                        setError(null);
                      }}
                    >
                      Use the code instead
                    </button>
                  </div>
                ) : (
                  <>
                    {activeSecondStep !== "totp" ? (
                      sent ? (
                        <output className="note note--ok">
                          <span>
                            A code was sent to {sent.to}. It is good for 10
                            minutes.
                          </span>
                        </output>
                      ) : (
                        <p className="hint">Sending a code…</p>
                      )
                    ) : null}
                    <div className="field">
                      <label htmlFor="unlock-totp">
                        {activeSecondStep === "totp"
                          ? "Authenticator code"
                          : activeSecondStep === "email"
                            ? "Code from the email"
                            : "Code from the text"}
                      </label>
                      <CodeField
                        id="unlock-totp"
                        inputRef={totpRef}
                        value={totp}
                        disabled={busy || lockedFor > 0}
                        onChange={setTotp}
                        onComplete={() => formRef.current?.requestSubmit()}
                      />
                      <p className="hint">
                        {activeSecondStep === "totp"
                          ? "The code your app shows for OpenSesame."
                          : "Six digits. Use the newest one you were sent."}
                      </p>
                      {activeSecondStep !== "totp" ? (
                        <button
                          type="button"
                          className="unlock__switch"
                          disabled={busy || resendIn > 0}
                          onClick={() => {
                            requestedFor.current = null;
                            setSent(null);
                            setSentAt(null);
                            setTotp("");
                            setError(null);
                          }}
                        >
                          {resendIn > 0
                            ? `Send it again · in ${resendIn}s`
                            : "Send it again"}
                        </button>
                      ) : null}
                      {header?.unlocks?.recovery ? (
                        <button
                          type="button"
                          className="unlock__switch"
                          onClick={() => {
                            setRecoveryMode(true);
                            setError(null);
                          }}
                        >
                          Use a recovery code
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
                <button
                  type="button"
                  className="unlock__switch"
                  onClick={() => {
                    store.cancelTotpChallenge();
                    setTotp("");
                    setRecovery("");
                    setRecoveryMode(false);
                    setError(null);
                  }}
                >
                  Start over
                </button>
              </>
            ) : null}

            {(firstRun || !awaitingSecondStep) &&
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

            {showsPinField ? (
              <div className="field">
                <label htmlFor="unlock-pin">
                  {awaitingPasskeyDuressCode
                    ? "Code"
                    : firstRun
                      ? "Device PIN"
                      : "PIN"}
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

            {showsPrimaryField && activeMethod === "password" && (
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
                    ref={acceptRef}
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  <span>I understand this vault cannot be recovered.</span>
                </label>
              </div>
            ) : header?.hint &&
              activeMethod === "password" &&
              !awaitingSecondStep ? (
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

            {noPrimary ? null : (
              <div className="go-row">
                <button
                  ref={(element) => {
                    goRef.current = element;
                    submitRef(element);
                  }}
                  type="submit"
                  className="go"
                  disabled={disabled}
                  aria-busy={busy}
                  aria-label={goVerb}
                  title={goVerb}
                >
                  {activeMethod === "passkey" &&
                  !awaitingSecondStep &&
                  !awaitingPasskeyDuressCode ? (
                    <IconPasskey size={18} />
                  ) : (
                    <IconArrowRight size={18} />
                  )}
                </button>
                <span className="go-verb" aria-hidden="true">
                  {goVerb}
                </span>
              </div>
            )}

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
              onClick={() => {
                // Both: this form may outlive the front door that mounted it.
                setLocalOnly(false);
                onSignInInstead?.();
              }}
            >
              Sign in instead
            </button>
          ) : null}
          {/* The guest road on the unlock form itself (GuestRoad.tsx): never
              gated on anything but the operator's "Allow guests" switch
              (AGENTS.md §5) — including beside the guest tomb, where it
              resumes rather than gates. */}
          {!firstRun && !showSignIn && !showReset ? (
            <GuestUnlockSwitch
              busy={busy}
              setBusy={setBusy}
              setError={setError}
            />
          ) : null}
          {!firstRun && !showSignIn ? (
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
                    className="icon-btn icon-btn--sm"
                    onClick={() => setShowReset(false)}
                    aria-label="Keep it"
                    title="Keep it"
                  >
                    <IconX size={16} />
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
      <ReleaseNotes />
    </div>
  );
}
