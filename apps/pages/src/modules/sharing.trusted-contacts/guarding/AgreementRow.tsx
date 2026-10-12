/**
 * An invitation this device agreed to and has not been answered: the circle,
 * the owner's key as the short name two people can check by voice, and a mark
 * that it is waiting. Its one key forgets the agreement, and takes two presses
 * (the second names what is lost, a keep key beside it hands the keyboard back
 * to the first): the receiving key goes with it, and an owner's welcome for it
 * can no longer be taken.
 */

import type { Agreement } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useRef, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { FailureMark } from "./marks.js";

function ForgetKey({
  circle,
  onForget,
}: {
  circle: string;
  /** Forgets it; says whether it did. A refusal is shown by the panel. */
  onForget: () => Promise<boolean>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const forget = useRef<HTMLButtonElement>(null);
  const name = `the invitation to ${circle}`;

  async function press(): Promise<void> {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    const forgotten = await onForget();
    setBusy(false);
    if (!forgotten) setArmed(false);
  }

  return (
    <>
      <IconKey
        keyRef={forget}
        label={armed ? `Forget ${name} for good` : `Forget ${name}`}
        small
        armed={armed}
        aria-busy={busy || undefined}
        onClick={() => void press()}
      >
        <IconTrash size={15} />
      </IconKey>
      {armed ? (
        <IconKey
          label={`Keep ${name}`}
          small
          onClick={() => {
            setArmed(false);
            forget.current?.focus();
          }}
        >
          <IconX size={15} />
        </IconKey>
      ) : null}
    </>
  );
}

export function AgreementRow({
  agreement,
  failure,
  onForget,
}: {
  agreement: Agreement;
  /** The sentence for why this one could not be forgotten; empty when it could. */
  failure: string;
  /** Forget it and read the list again; says whether it did. */
  onForget: (agreement: Agreement) => Promise<boolean>;
}) {
  return (
    <li className="tc-row">
      <h3>{agreement.circleLabel}</h3>
      <span className="tc-row__facts">
        {`Invited by ${agreement.ownerFingerprint}`}
      </span>
      <span className="tc-row__marks">
        <StatusMark tone="idle" label="Waiting for what the owner sends" />
        <FailureMark message={failure} />
      </span>
      <span className="tc-row__keys">
        <ForgetKey
          circle={agreement.circleLabel}
          onForget={() => onForget(agreement)}
        />
      </span>
    </li>
  );
}
