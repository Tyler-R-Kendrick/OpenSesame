/**
 * Agreeing to guard someone's circle, as a ceremony in a sheet (ADR 0186 §10).
 *
 * The sheet draws in three states. A paste field takes the invitation and says
 * nothing else until a person presses its key. Reading it shows what is being
 * agreed to — the circle, the owner's key as a short name two people can check
 * by voice, and the origins it opens at — with a name and the security keys to
 * register; the page being one of those origins is checked first, and when it
 * is not, the card says where to open it and offers nothing. Agreeing makes the
 * keys answer and ends in the one packet to hand back to the owner. The
 * receiving key that comes with it is sealed in this vault by the desk and is
 * never drawn.
 */

import { useRef } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconPlus } from "../../../components/Icons.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import type { Desk } from "../use-desk.js";
import { BackupSwitch } from "./backup-switch.js";
import { inviteFacts, originMark } from "./guarding-model.js";
import { FailureMark, MarkLine, Marked } from "./marks.js";
import { type AcceptFlow, type Reading, useAccept } from "./use-accept.js";
import {
  closeKeyOf,
  copyKeyIn,
  firstOf,
  useLandOnMount,
  useLandWhenSettled,
} from "./use-land.js";

function Agree({ flow, reading }: { flow: AcceptFlow; reading: Reading }) {
  const { view } = reading;
  const body = useRef<HTMLDivElement>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  const agreeKey = useRef<HTMLButtonElement>(null);
  useLandOnMount(() => firstOf(nameBox.current, closeKeyOf(body.current)));
  useLandWhenSettled(flow.busy, () => agreeKey.current);
  const marked = !view.originOk || flow.failure.message !== "";
  return (
    <div ref={body}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void flow.agree();
        }}
      >
        <CeremonyShell
          name={view.invite.label}
          facts={inviteFacts(view)}
          primary={
            view.originOk
              ? {
                  label: "Agree",
                  submit: true,
                  busy: flow.busy,
                  disabled: !flow.ready,
                  onClick: () => void flow.agree(),
                  keyRef: agreeKey,
                }
              : undefined
          }
        >
          {view.originOk ? (
            <>
              <FieldShell
                id="guarding-name"
                inputRef={nameBox}
                label="Your name"
                autoComplete="off"
                value={flow.name}
                readOnly={flow.busy}
                onValueChange={flow.setName}
              />
              <BackupSwitch
                on={flow.backup}
                disabled={flow.busy}
                onChange={flow.setBackup}
              />
            </>
          ) : null}
          {marked ? (
            <MarkLine>
              {view.originOk ? null : <Marked mark={originMark(view)} />}
              <FailureMark message={flow.failure.message} />
            </MarkLine>
          ) : null}
        </CeremonyShell>
      </form>
    </div>
  );
}

function Answered({ label, answer }: { label: string; answer: string }) {
  const body = useRef<HTMLDivElement>(null);
  useLandOnMount(() =>
    firstOf(copyKeyIn(body.current, "your answer"), closeKeyOf(body.current)),
  );
  return (
    <div ref={body}>
      <CeremonyShell top="Agreed" name={label}>
        <PacketOut
          label="Your answer"
          copyLabel="your answer"
          packet={answer}
        />
      </CeremonyShell>
    </div>
  );
}

/** The state the sheet is in: a paste, the agreement it was read into, or the answer it ended in. */
function Stage({ flow }: { flow: AcceptFlow }) {
  const { reading, answer } = flow;
  if (reading && answer) {
    return (
      <Answered label={reading.view.invite.label} answer={answer.enrollment} />
    );
  }
  if (reading) return <Agree flow={flow} reading={reading} />;
  return (
    <PacketIn
      id="guarding-invite"
      label="An invitation"
      kind="invite"
      commitLabel="Read this invitation"
      onPacket={flow.read}
    />
  );
}

export function AcceptSheet({
  desk,
  onAgreed,
  onClose,
}: {
  desk: Desk;
  /** The agreement is kept: the panel lists it as waiting. */
  onAgreed: () => void;
  onClose: () => void;
}) {
  const flow = useAccept(desk, onAgreed);
  return (
    <CeremonySheet
      title="Accept an invitation"
      mark={<IconPlus size={20} />}
      onClose={onClose}
    >
      <Stage flow={flow} />
    </CeremonySheet>
  );
}
