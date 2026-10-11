/**
 * Taking what a circle's owner sent, as a ceremony in a sheet (ADR 0187 §10).
 *
 * One paste field takes either of the two things an owner hands a guardian: a
 * welcome (the signed policy and, in a circle that holds shares, this
 * guardian's sealed share) and a policy that arrives by itself (a new epoch,
 * or the end of a seat). The field says which it is before a person presses
 * its key. A welcome with a share touches the key twice and ends in a receipt
 * to hand back; a seat has nothing to hand back. A policy is applied to the
 * circle this device holds and its outcome is a mark.
 */

import {
  type NoticeOutcome,
  type Taken,
  applyNotice,
  takeWelcome,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  type Packet,
  expectPacket,
  packetKind,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconDownload } from "../../../components/Icons.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import type { Desk } from "../use-desk.js";
import { noticeMark, takenMark } from "./guarding-model.js";
import { MarkLine, Marked } from "./marks.js";
import { closeKeyOf, copyKeyIn, firstOf, useLandOnMount } from "./use-land.js";

type Result =
  | Readonly<{ kind: "welcome"; taken: Taken }>
  | Readonly<{ kind: "policy"; label: string; outcome: NoticeOutcome }>;

/** What a pasted packet is, before it is acted on: its kind, its circle and its epoch. */
export function describeTaking(packet: Packet): string | null {
  if (packet.kind === "welcome") {
    const { policy } = packet.value.signedPolicy;
    return `A welcome to ${policy.label}, epoch ${policy.epoch}`;
  }
  if (packet.kind === "policy") {
    const { policy } = packet.value;
    return `A new policy for ${policy.label}, epoch ${policy.epoch}`;
  }
  return null;
}

async function take(desk: Desk, text: string): Promise<Result> {
  if (packetKind(text) === "policy") {
    const { label } = expectPacket(text, "policy").value.policy;
    const outcome = await applyNotice(desk.ports, text);
    await desk.refresh();
    return { kind: "policy", label, outcome };
  }
  const taken = await takeWelcome(desk.ports, text);
  await desk.refresh();
  return { kind: "welcome", taken };
}

function Done({ result }: { result: Result }) {
  const body = useRef<HTMLDivElement>(null);
  useLandOnMount(() =>
    firstOf(copyKeyIn(body.current, "your receipt"), closeKeyOf(body.current)),
  );
  return (
    <div ref={body}>
      {result.kind === "policy" ? (
        <CeremonyShell name={result.label}>
          <MarkLine>
            <Marked mark={noticeMark(result.label, result.outcome)} />
          </MarkLine>
        </CeremonyShell>
      ) : (
        <CeremonyShell
          name={result.taken.circleLabel}
          facts={[{ key: "Epoch", value: String(result.taken.epoch) }]}
        >
          <MarkLine>
            <Marked mark={takenMark(result.taken)} />
          </MarkLine>
          {result.taken.receipt ? (
            <PacketOut
              label="Your receipt"
              copyLabel="your receipt"
              packet={result.taken.receipt}
            />
          ) : null}
        </CeremonyShell>
      )}
    </div>
  );
}

export function TakeSheet({
  desk,
  onTaken,
  onClose,
}: {
  desk: Desk;
  /** Something was taken: an agreement it answered is no longer waiting. */
  onTaken: () => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  return (
    <CeremonySheet
      title="Take what an owner sent"
      mark={<IconDownload size={20} />}
      onClose={onClose}
    >
      {result ? (
        <Done result={result} />
      ) : (
        <PacketIn
          id="guarding-take-in"
          label="What an owner sent"
          kind={["welcome", "policy"]}
          commitLabel="Take what was sent"
          icon={<IconDownload size={17} />}
          describe={describeTaking}
          onPacket={async (text) => {
            setResult(await take(desk, text));
            onTaken();
          }}
        />
      )}
    </CeremonySheet>
  );
}
