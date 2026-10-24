/** The two standing notes on the unlock form: storage that will not last, and a lockout. */

import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type { VaultHeader } from "@opensesame/vault-core";
import type { Ref } from "react";

/** A browser that keeps nothing across tabs. Said once, on the form, because it changes what is safe to store. */
export function DurabilityNote({ durable }: { durable: boolean }) {
  if (durable) return null;
  return (
    <output className="note note--warn">
      <span>
        This browser gives this app no persistent storage, so the vault will be
        gone when the tab closes — private windows and some embedded browsers do
        this. Do not put your only copy of anything in here.
      </span>
    </output>
  );
}

/** Too many wrong tries: how long until the next. */
export function LockoutNote({
  lockedFor,
  failedAttempts,
}: {
  lockedFor: number;
  failedAttempts: number;
}) {
  if (lockedFor <= 0) return null;
  return (
    <output className="note note--warn">
      <span>
        {failedAttempts} failed attempts. Try again in {lockedFor}s.
      </span>
    </output>
  );
}

/** The key form's acknowledgement or reminder, followed by its storage notice. */
export function FormNotes({
  firstRun,
  activeMethod,
  acceptRef,
  accepted,
  setAccepted,
  header,
  awaitingSecondStep,
  durable,
}: {
  firstRun: boolean;
  activeMethod: UnlockTabId;
  acceptRef: Ref<HTMLInputElement>;
  accepted: boolean;
  setAccepted: (value: boolean) => void;
  header: VaultHeader | null;
  awaitingSecondStep: boolean;
  durable: boolean;
}) {
  return (
    <>
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
      ) : header?.hint && activeMethod === "password" && !awaitingSecondStep ? (
        <p className="unlock__hint">
          <strong>Reminder:</strong> {header.hint}
        </p>
      ) : null}
      <DurabilityNote durable={durable} />
    </>
  );
}
