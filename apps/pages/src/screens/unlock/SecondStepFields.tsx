import type { SentCode } from "@opensesame/app-core/lib/vault/remote-code.js";
import type { SecondStepId } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { RefObject } from "react";
import { IconMail, IconMessage, IconPhone } from "../../components/Icons.js";
import { CodeField } from "./CodeField.js";
import { SECOND_STEP_LABEL } from "./labels.js";

/**
 * Step 2 of the unlock: the code the vault's enrolled authenticator, email or
 * text channel asks for, or one of the recovery codes standing in for it.
 * Presentation only — the screen owns the state and the submit.
 */
type StepTabsProps = {
  secondSteps: SecondStepId[];
  activeSecondStep: SecondStepId;
  lockedFor: number;
  onPickStep: (id: SecondStepId) => void;
};

function StepIcon({ id }: { id: SecondStepId }) {
  if (id === "totp") return <IconPhone size={16} />;
  return id === "email" ? <IconMail size={16} /> : <IconMessage size={16} />;
}

function StepTabs({
  secondSteps,
  activeSecondStep,
  lockedFor,
  onPickStep,
}: StepTabsProps) {
  return (
    <div className="unlock__methods" role="tablist" aria-label="Second step">
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
          onClick={() => onPickStep(id)}
        >
          <StepIcon id={id} />
          {SECOND_STEP_LABEL[id]}
        </button>
      ))}
    </div>
  );
}

function RecoveryCodeField({
  value,
  disabled,
  inputRef,
  onChange,
  onUseCode,
}: {
  value: string;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onUseCode: () => void;
}) {
  return (
    <div className="field">
      <label htmlFor="unlock-recovery">Recovery code</label>
      <input
        id="unlock-recovery"
        ref={inputRef}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="xxxx-xxxx"
      />
      <p className="hint">
        One of the codes you saved. It opens the vault once, then it is spent.
      </p>
      <button type="button" className="unlock__switch" onClick={onUseCode}>
        Use the code instead
      </button>
    </div>
  );
}

const CODE_LABEL = {
  totp: "Authenticator code",
  email: "Code from the email",
  sms: "Code from the text",
} satisfies Record<SecondStepId, string>;

function CodeStep({
  activeSecondStep,
  hasRecoveryCodes,
  sent,
  resendIn,
  busy,
  disabled,
  totp,
  totpRef,
  onTotp,
  onUseRecoveryCode,
  onResend,
  onComplete,
}: {
  activeSecondStep: SecondStepId;
  hasRecoveryCodes: boolean;
  sent: SentCode | null;
  resendIn: number;
  busy: boolean;
  disabled: boolean;
  totp: string;
  totpRef: RefObject<HTMLInputElement | null>;
  onTotp: (value: string) => void;
  onUseRecoveryCode: () => void;
  onResend: () => void;
  onComplete: () => void;
}) {
  const sentByChannel = activeSecondStep !== "totp";
  return (
    <>
      {sentByChannel ? (
        sent ? (
          <output className="note note--ok">
            <span>
              A code was sent to {sent.to}. It is good for 10 minutes.
            </span>
          </output>
        ) : (
          <p className="hint">Sending a code…</p>
        )
      ) : null}
      <div className="field">
        <label htmlFor="unlock-totp">{CODE_LABEL[activeSecondStep]}</label>
        <CodeField
          id="unlock-totp"
          inputRef={totpRef}
          value={totp}
          disabled={disabled}
          onChange={onTotp}
          onComplete={onComplete}
        />
        <p className="hint">
          {sentByChannel
            ? "Six digits. Use the newest one you were sent."
            : "The code your app shows for OpenSesame."}
        </p>
        {sentByChannel ? (
          <button
            type="button"
            className="unlock__switch"
            // Not the lockout: asking for a fresh code is not an attempt.
            disabled={busy || resendIn > 0}
            onClick={onResend}
          >
            {resendIn > 0 ? `Send it again · in ${resendIn}s` : "Send it again"}
          </button>
        ) : null}
        {hasRecoveryCodes ? (
          <button
            type="button"
            className="unlock__switch"
            onClick={onUseRecoveryCode}
          >
            Use a recovery code
          </button>
        ) : null}
      </div>
    </>
  );
}

export function SecondStepFields(
  props: StepTabsProps & {
    recoveryMode: boolean;
    hasRecoveryCodes: boolean;
    sent: SentCode | null;
    resendIn: number;
    busy: boolean;
    totp: string;
    recovery: string;
    totpRef: RefObject<HTMLInputElement | null>;
    onTotp: (value: string) => void;
    onRecovery: (value: string) => void;
    onUseRecoveryCode: () => void;
    onUseCode: () => void;
    onResend: () => void;
    onStartOver: () => void;
    onComplete: () => void;
  },
) {
  const disabled = props.busy || props.lockedFor > 0;
  return (
    <>
      {props.secondSteps.length > 1 && !props.recoveryMode ? (
        <StepTabs {...props} />
      ) : null}
      {props.recoveryMode ? (
        <RecoveryCodeField
          value={props.recovery}
          disabled={disabled}
          inputRef={props.totpRef}
          onChange={props.onRecovery}
          onUseCode={props.onUseCode}
        />
      ) : (
        <CodeStep {...props} disabled={disabled} />
      )}
      <button
        type="button"
        className="unlock__switch"
        onClick={props.onStartOver}
      >
        Start over
      </button>
    </>
  );
}
