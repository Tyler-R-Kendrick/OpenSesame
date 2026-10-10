import {
  outcomeWantsSignIn,
  readAuthOutcome,
} from "@opensesame/app-core/lib/auth-outcome.js";
import { currentSession } from "@opensesame/app-core/lib/identity.js";
import { PERSONAL_PROJECT_ID } from "@opensesame/app-core/lib/projects.js";
import type { FederatedProviderSummary } from "@opensesame/app-core/lib/providers.js";
import { noWayIn } from "@opensesame/app-core/lib/settings.js";
import { loadSetup, unlockViable } from "@opensesame/app-core/lib/setup.js";
import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type { SentCode } from "@opensesame/app-core/lib/vault/remote-code.js";
import { GUEST_TOMB } from "@opensesame/app-core/lib/vault/store.js";
import {
  MIN_PIN_LENGTH,
  type SecondStepId,
  checkWebauthnHost,
  listSecondSteps,
  pinPolicyProblems,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  type DeviceVault,
  deviceHasSeveralVaults,
  listDeviceVaults,
  switchVault,
} from "@opensesame/app-core/lib/vaults.js";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FailureNotice } from "../components/FailureNotice.js";
import { IconKey } from "../components/IconKey.js";
import {
  IconArrowRight,
  IconEye,
  IconEyeOff,
  IconPasskey,
  IconSettings,
} from "../components/Icons.js";
import { checkForAppUpdate } from "../lib/pwa-update.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { FrontDoor } from "./FrontDoor.js";
import { SetupScreen, type SetupStep } from "./SetupScreen.js";
import { VaultsScreen } from "./VaultsScreen.js";
import { RequirementsGate } from "./capabilities/RequirementsGate.js";
import { useJoinRoad } from "./join/JoinRoad.js";
import { GuestUnlockSwitch } from "./unlock/GuestRoad.js";
import { LockFoot } from "./unlock/LockFoot.js";
import { MethodIcon } from "./unlock/MethodIcon.js";
import { NoPrimaryNote } from "./unlock/NoPrimaryNote.js";
import { DurabilityNote, LockoutNote } from "./unlock/Notes.js";
import { PasskeyChoice } from "./unlock/PasskeyChoice.js";
import { ProtectorField } from "./unlock/ProtectorField.js";
import { ResetVault } from "./unlock/ResetVault.js";
import { SecondStepFields } from "./unlock/SecondStepFields.js";
import { SignInPanel } from "./unlock/SignInPanel.js";
import { UnlockStage } from "./unlock/UnlockStage.js";
import { UnlockUserMenu } from "./unlock/UnlockUserMenu.js";
import {
  METHOD_LABEL,
  RESEND_COOLDOWN_MS,
  isCeremonyMethod,
  isTypedProtector,
  unlockGoVerb,
  unlockTitle,
} from "./unlock/labels.js";
import { useUnlockFormFocus } from "./unlock/unlock-form-focus.js";
import { submitUnlockForm } from "./unlock/unlock-form-submit.js";
import {
  fallbackUnlockMethod,
  unlockMethodTabs,
} from "./unlock/unlock-method-tabs.js";
import { useFederatedProviders } from "./unlock/use-federated-providers.js";
import { usePasskeyCeremony } from "./unlock/use-passkey-ceremony.js";
import { usePasskeyRoad } from "./unlock/use-passkey-road.js";
import { useUnlockRoute, useUnlockTargets } from "./unlock/use-unlock-gate.js";
import { useUnlockLockV5 } from "./unlock/use-unlock-lock-v5.js";
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
 * A device with no vault opens on the front door's two roads — set up your
 * own, join a session (ADR 0150 §1); nothing is put in front of them
 * (ADR 0090). Once a setup record exists, sign-in is the first screen. A
 * shared link opens join itself (ADR 0136), and a managed instance's
 * required roots sit beside sign-in.
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
  // The front door (ADR 0115, ADR 0150 §1): no vault and no setup record.
  // An answered or skipped ceremony retires it; guest prepare leaves status
  // empty (no wrap on disk), which is Unlock.
  const frontDoor =
    status === "empty" &&
    tomb !== GUEST_TOMB &&
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
        onOpenSetup={(join) => setCeremony({ step: undefined, join })}
        onOpenJoin={join.open}
      />
    );
  }
  return (
    <UnlockForm
      providers={providers}
      onOpenSetup={(step, join) => setCeremony({ step, join })}
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
  onOpenSetup: (step?: SetupStep, join?: boolean) => void;
  /** Back to the front door: every vault on this device (ADR 0089). */
  onOpenVaults: () => void;
}) {
  const { submitRef, secretRef, passkeyRef, setupRef, methodsRef } =
    useUnlockTargets();
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
  const passkeyOk = usePasskeyRoad(passkeyHost.ok);
  // First run leads with identity (ADR 0033 §4): sign-in is the default stage, the local seal form the explicit road.
  const [localOnly, setLocalOnly] = useState(false);
  const signInStage = firstRun && !localOnly;
  // A returning vault shows the key ceremony; sign-in lives in the user menu. Mid-MFA the code field is the screen.
  const [signingIn, setSigningIn] = useState(() =>
    outcomeWantsSignIn(readAuthOutcome()),
  );
  const returning = unlockViable(status) && !awaitingSecondStep;
  const showSignIn = returning && signingIn;
  // Not "no identity service" (ADR 0078) — the narrower and truer claim: setup left no way in.
  const nothingSignsIn = unlockScreenDependencies.noWayIn();

  const methods = useMemo<UnlockTabId[]>(
    () => unlockMethodTabs({ firstRun, header, passkeyOk }),
    [firstRun, header, passkeyOk],
  );
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
  const [method, setMethod] = useState<UnlockTabId | null>(null);
  const [awaitingPasskeyDuressCode, setAwaitingPasskeyDuressCode] =
    useState(false);
  const fallbackMethod = fallbackUnlockMethod({
    firstRun,
    header,
    passkeyOk,
    methods,
  });
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
  const keyed = showMethodTabs && showsPrimaryField;
  useUnlockRoute(signInStage, showSignIn, keyed ? activeMethod : "");
  const showsPinField =
    !awaitingSecondStep &&
    (awaitingPasskeyDuressCode ||
      (showsPrimaryField && activeMethod === "pin"));

  const [password, setPassword] = useState("");
  const [protectorSecret, setProtectorSecret] = useState("");
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
  const [accepted, setAccepted] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const protectorRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const acceptRef = useRef<HTMLInputElement>(null);
  const { stage: lockStage, beginCeremonyIfUnlocked } = useUnlockLockV5(status);

  const lockedFor = useCountdown(lockedOutUntil);
  const ceremony = usePasskeyCeremony(
    setAwaitingPasskeyDuressCode,
    setBusy,
    setError,
    setMethod,
  );
  const { passkeyAbort, cancelPasskeyCeremony, attachment } = ceremony;

  const formGated = lockedFor > 0;
  const pendingFocus = useUnlockFormFocus({
    busy,
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
    protectorRef,
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

  async function onSubmit(event: FormEvent) {
    const before = status;
    await submitUnlockForm({
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
      attachment,
      onSealUnsupported: ceremony.sealUnsupported,
      pin,
      confirm,
      password,
      protectorSecret,
      recovery,
      totp,
      setPin,
      setConfirm,
      setPassword,
      setProtectorSecret,
      setRecovery,
      setTotp,
      pinRef,
      passwordRef,
      protectorRef,
      totpRef,
      pendingFocus,
    });
    beginCeremonyIfUnlocked(before, signInStage || showSignIn || firstRun);
  }

  const pinProblems =
    firstRun && activeMethod === "pin" ? pinPolicyProblems(pin) : [];
  const pinProblem =
    activeMethod === "pin" && pin.length > 0 ? (pinProblems[0] ?? null) : null;
  // A new vault is sealed with a passkey or a PIN, never a password (ADR 0180).
  const createBlocked =
    !accepted ||
    (isCeremonyMethod(activeMethod)
      ? !passkeyHost.ok
      : activeMethod !== "pin" || pinProblems.length > 0 || pin !== confirm);

  let unlockBlocked = true;
  if (guestKeyless) unlockBlocked = false;
  else if (noPrimary) unlockBlocked = true;
  else if (awaitingSecondStep)
    unlockBlocked = recoveryMode
      ? recovery.replace(/[^a-z0-9]/gi, "").length < 8
      : totp.replace(/\s/g, "").length < 6;
  else if (awaitingPasskeyDuressCode) unlockBlocked = pin.length < 4;
  else if (isCeremonyMethod(activeMethod)) unlockBlocked = !passkeyHost.ok;
  else if (isTypedProtector(activeMethod))
    unlockBlocked = protectorSecret.trim().length === 0;
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
    <UnlockStage {...lockStage}>
      <div className="unlock__heading">
        <h1 className="unlock__title">
          {unlockTitle({
            signIn: signInStage || showSignIn,
            firstRun,
            awaitingSecondStep,
          })}
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
          <IconKey
            label="Set it up"
            small
            keyRef={setupRef}
            onClick={() => onOpenSetup("identity")}
          >
            <IconSettings size={16} />
          </IconKey>
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
              ref={methodsRef}
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
                    setProtectorSecret("");
                    setReveal(false); // one toggle serves every field
                  }}
                >
                  <MethodIcon id={id} />
                  {METHOD_LABEL[id]}
                </button>
              ))}
            </div>
          ) : null}

          {awaitingSecondStep ? (
            <SecondStepFields
              secondSteps={secondSteps}
              activeSecondStep={activeSecondStep}
              recoveryMode={recoveryMode}
              hasRecoveryCodes={!!header?.unlocks?.recovery}
              sent={sent}
              resendIn={resendIn}
              busy={busy}
              lockedFor={lockedFor}
              totp={totp}
              recovery={recovery}
              totpRef={totpRef}
              onPickStep={(id) => {
                setSecondStep(id);
                setTotp("");
                setError(null);
              }}
              onTotp={setTotp}
              onRecovery={setRecovery}
              onUseRecoveryCode={() => {
                setRecoveryMode(true);
                setError(null);
              }}
              onUseCode={() => {
                setRecoveryMode(false);
                setRecovery("");
                setError(null);
              }}
              onResend={() => {
                requestedFor.current = null;
                setSent(null);
                setSentAt(null);
                setTotp("");
                setError(null);
              }}
              onStartOver={() => {
                store.cancelTotpChallenge();
                setTotp("");
                setRecovery("");
                setRecoveryMode(false);
                setError(null);
              }}
              onComplete={() => formRef.current?.requestSubmit()}
            />
          ) : null}

          {(firstRun || !awaitingSecondStep) &&
          isCeremonyMethod(activeMethod) ? (
            <PasskeyChoice
              host={passkeyHost}
              seals={firstRun && activeMethod === "passkey"}
              value={attachment}
              onPick={ceremony.pickAttachment}
            />
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
                title={
                  firstRun
                    ? `${MIN_PIN_LENGTH}–12 characters, no repeated character, no sequential digits`
                    : undefined
                }
                aria-invalid={pinProblem ? true : undefined}
                disabled={busy || lockedFor > 0}
                onChange={(e) => setPin(e.target.value)}
              />
              {pinProblem ? (
                <p className="hint" aria-live="polite">
                  {pinProblem}
                </p>
              ) : null}
            </div>
          ) : null}

          {showsPrimaryField &&
          (activeMethod === "recovery" || activeMethod === "age") ? (
            <ProtectorField
              method={activeMethod}
              value={protectorSecret}
              reveal={reveal}
              disabled={busy || lockedFor > 0}
              inputRef={(element) => {
                protectorRef.current = element;
                secretRef(element);
              }}
              onValue={setProtectorSecret}
              onReveal={() => setReveal((value) => !value)}
            />
          ) : null}

          {showsPrimaryField && activeMethod === "password" && (
            <div className="field">
              <label htmlFor="master">Password</label>
              <div className="unlock__reveal">
                <input
                  id="master"
                  ref={(element) => {
                    passwordRef.current = element;
                    secretRef(element);
                  }}
                  type={reveal ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  disabled={busy || lockedFor > 0}
                  onChange={(e) => setPassword(e.target.value)}
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
                  ? "There is no recovery. Lose this device's authenticator and the encrypted items on this device are unreadable — by you and by us. An authenticator that cannot seal fails on Seal; the PIN tab works on any device."
                  : "There is no recovery. Forget this PIN and the encrypted items on this device are unreadable — by you and by us."}
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

          <DurabilityNote durable={durable} />

          <FailureNotice id="unlock:error" title="Unlock" message={error} />

          <LockoutNote lockedFor={lockedFor} failedAttempts={failedAttempts} />

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
                {isCeremonyMethod(activeMethod) &&
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
        {/* Guest tomb beside a sealed vault (GuestRoad.tsx). Not on
              sign-in or a keyless tomb — Unlock resumes that tomb. Allow
              guests is the only gate (AGENTS.md §5). */}
        {!firstRun && !showSignIn && !showReset ? (
          <GuestUnlockSwitch
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            hidden={guestKeyless}
          />
        ) : null}
        {!firstRun && !showSignIn ? (
          <ResetVault
            open={showReset}
            onOpen={() => setShowReset(true)}
            onDelete={() => void store.destroy()}
            onKeep={() => setShowReset(false)}
          />
        ) : null}
        <LockFoot variant="foot" hideReset={showReset} />
      </div>
    </UnlockStage>
  );
}
