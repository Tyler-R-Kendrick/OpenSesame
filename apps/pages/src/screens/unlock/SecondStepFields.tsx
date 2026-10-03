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
export function SecondStepFields({
  secondSteps,
  activeSecondStep,
  recoveryMode,
  hasRecoveryCodes,
  sent,
  resendIn,
  busy,
  lockedFor,
  totp,
  recovery,
  totpRef,
  onPickStep,
  onTotp,
  onRecovery,
  onUseRecoveryCode,
  onUseCode,
  onResend,
  onStartOver,
  onComplete,
}: {
  secondSteps: SecondStepId[];
  activeSecondStep: SecondStepId;
  recoveryMode: boolean;
  hasRecoveryCodes: boolean;
  sent: SentCode | null;
  resendIn: number;
  busy: boolean;
  lockedFor: number;
  totp: string;
  recovery: string;
  totpRef: RefObject<HTMLInputElement | null>;
  onPickStep: (id: SecondStepId) => void;
  onTotp: (value: string) => void;
  onRecovery: (value: string) => void;
  onUseRecoveryCode: () => void;
  onUseCode: () => void;
  onResend: () => void;
  onStartOver: () => void;
  onComplete: () => void;
}) {
  return (
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
              onClick={() => onPickStep(id)}
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
            onChange={(e) => onRecovery(e.target.value)}
            placeholder="xxxx-xxxx"
          />
          <p className="hint">
            One of the codes you saved. It opens the vault once, then it is
            spent.
          </p>
          <button type="button" className="unlock__switch" onClick={onUseCode}>
            Use the code instead
          </button>
        </div>
      ) : (
        <>
          {activeSecondStep !== "totp" ? (
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
              onChange={onTotp}
              onComplete={onComplete}
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
                onClick={onResend}
              >
                {resendIn > 0
                  ? `Send it again · in ${resendIn}s`
                  : "Send it again"}
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
      )}
      <button type="button" className="unlock__switch" onClick={onStartOver}>
        Start over
      </button>
    </>
  );
}
