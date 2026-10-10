/**
 * One recovery in flight (ADR 0186 §10): the request to hand each contact,
 * the approvals and then the releases they send back, where it stands, and
 * the key that opens it once enough shares are in.
 *
 * Every pasted answer is checked by the ledger. A refused one is a mark and a
 * notice, and the ones that were accepted still count. What opens is handed
 * to `onOpened` as the text of a file and never drawn here.
 */

import type { RecoveryView } from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { PacketKind } from "@opensesame/app-core/lib/quorum/packets.js";
import { useRef } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { ReloadKey } from "../../../components/IconKey.js";
import { IconShield } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useFocusAfter } from "../../../lib/use-focus-after.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import { useSaid } from "../panel-frame.js";
import { recoveryMark } from "../row-model.js";
import type { Desk } from "../use-desk.js";
import { GiveUpKey } from "./GiveUpKey.js";
import { canOpen, describeAnswer, statusFact } from "./recovery-model.js";
import {
  type RecoveryRun,
  type RecoveryRunInput,
  useRecovery,
} from "./use-recovery.js";

const ANSWER_KINDS: PacketKind[] = ["approval", "approvals", "release"];

/** The mark for where it stands, and the key that reads the clock again. */
function StatusLine({ run }: { run: RecoveryRun }) {
  const mark = recoveryMark(run.view.status);
  return (
    <div className="rc-status">
      <StatusMark tone={mark.tone} label={mark.label} />
      <ReloadKey label="Check the status" onReload={() => void run.check()} />
      {run.checkFailure ? (
        <StatusMark tone="err" label={run.checkFailure} />
      ) : null}
    </div>
  );
}

/** What the last paste and the last try to open left to say: refusals, and whom to ask again. */
function Aftermath({ run }: { run: RecoveryRun }) {
  return (
    <>
      {run.refused.length > 0 ? (
        <div className="actions">
          {run.refused.map((refusal) => (
            <StatusMark key={refusal} tone="err" label={refusal} />
          ))}
        </div>
      ) : null}
      {run.askAgain.length > 0 ? (
        <ul className="rc-names">
          {run.askAgain.map((contact) => (
            <li key={contact.id} className="rc-name">
              <StatusMark
                tone="warn"
                label={`Ask ${contact.name} to release again`}
              />
              <span>{contact.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.openFailure ? (
        <div className="actions">
          <StatusMark tone="err" label={run.openFailure} />
        </div>
      ) : null}
    </>
  );
}

/** What goes out, and what comes back: the request, the approvals so far, and the field for answers. */
function Packets({ run }: { run: RecoveryRun }) {
  return (
    <>
      <PacketOut
        label="The request"
        copyLabel="the request"
        packet={run.view.request}
      />
      {run.approvals ? (
        <PacketOut
          label="The approvals so far"
          copyLabel="the approvals"
          packet={run.approvals}
        />
      ) : null}
      <PacketIn
        id="recovery-answer"
        label="An approval or a release"
        kind={ANSWER_KINDS}
        commitLabel="Add"
        failureId="trusted-contacts:recovery-answer"
        failureTitle="Recovery"
        describe={describeAnswer(run.view)}
        onPacket={run.add}
      />
    </>
  );
}

export function RecoverySheet({
  desk,
  initial,
  onChanged,
  onOpened,
  onGaveUp,
  onClose,
}: Pick<RecoveryRunInput, "onChanged" | "onOpened" | "onGaveUp"> & {
  desk: Desk;
  /** The recovery as the panel last read it; the sheet reads it again on open. */
  initial: RecoveryView;
  onClose: () => void;
}) {
  const run = useRecovery({ desk, initial, onChanged, onOpened, onGaveUp });
  const { view } = run;
  const fact = statusFact(view);
  const said = useSaid(fact);
  const openKey = useRef<HTMLButtonElement>(null);
  // Opening switches the key off while it works, which drops the keyboard.
  const land = useFocusAfter(run.opening);
  const open = () => {
    void run.open();
    // Opening can leave nothing to open; the next thing is then another release.
    land(() => openKey.current ?? document.getElementById("recovery-answer"));
  };
  return (
    <CeremonySheet
      title={`${view.label} recovery`}
      mark={<IconShield size={20} />}
      onClose={onClose}
    >
      <output className="visually-hidden" aria-live="polite">
        {said}
      </output>
      <CeremonyShell
        name={fact}
        primary={
          canOpen(view)
            ? {
                label: "Open the recovery",
                busy: run.opening,
                keyRef: openKey,
                onClick: open,
              }
            : undefined
        }
      >
        <StatusLine run={run} />
        <Packets run={run} />
        <Aftermath run={run} />
      </CeremonyShell>
      <GiveUpKey
        busy={run.giving}
        failure={run.giveUpFailure}
        onGiveUp={() => void run.giveUp()}
      />
    </CeremonySheet>
  );
}
