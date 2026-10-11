/**
 * What the owner hands out once a circle (or a new epoch of one) is made: a
 * packet for each contact, a notice for each who has left, the recovery file,
 * and the place their receipts come back to.
 *
 * The desk keeps the packets until every contact's receipt is in
 * (`readDealt`), so closing this step strands no one: the circle's sheet
 * offers it again. Where they could not be kept the step says they are shown
 * once, which is then true. A contact's receipt is what turns the circle from
 * waiting to armed.
 */

import {
  type CustodyStatus,
  type Dealt,
  type Handout,
  recordReceipt,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Packet } from "@opensesame/app-core/lib/quorum/packets.js";
import { useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconDownload } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { PacketIn, PacketOut, downloadFile } from "../packet-field.js";
import { circleMark } from "../row-model.js";
import type { Desk } from "../use-desk.js";
import type { Payload } from "./circle-payload.js";

export type Carried = Pick<Payload, "skipped" | "withheld">;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function Notes({ carried }: { carried: Carried | null }) {
  if (!carried || (carried.skipped === 0 && carried.withheld === 0)) {
    return null;
  }
  return (
    <>
      {carried.skipped > 0 ? (
        <StatusMark
          tone="idle"
          label={`${carried.skipped} ${plural(carried.skipped, "item was", "items were")} left out of the recovery file`}
        />
      ) : null}
      {carried.withheld > 0 ? (
        <StatusMark
          tone="idle"
          label={`${carried.withheld} ${plural(carried.withheld, "password was", "passwords were")} held back from the recovery file`}
        />
      ) : null}
    </>
  );
}

function HandoutRow({
  handout,
  noun,
  holds,
}: {
  handout: Handout;
  noun: "packet" | "notice";
  /** The contact's receipt is in; `null` where no receipt is expected. */
  holds: boolean | null;
}) {
  return (
    <div className="tcc-dealt">
      <PacketOut label={`${handout.name}'s ${noun}`} packet={handout.packet} />
      {holds === null ? null : (
        <StatusMark
          tone={holds ? "ok" : "idle"}
          label={
            holds
              ? `${handout.name} holds a share`
              : `Waiting for ${handout.name}'s receipt`
          }
        />
      )}
    </div>
  );
}

function DealtMarks({
  dealt,
  armed,
  replacesFile,
  carried,
}: {
  dealt: Dealt;
  armed: boolean;
  replacesFile: boolean;
  carried: Carried | null;
}) {
  const state = circleMark(armed ? "armed" : "inviting");
  return (
    <span className="tc-row__marks">
      {dealt.kept ? null : (
        <StatusMark tone="idle" label="Packets are shown once" />
      )}
      <StatusMark tone={state.tone} label={state.label} />
      {dealt.warnings.map((warning) => (
        <StatusMark
          key={`${warning.code}:${warning.message}`}
          tone="warn"
          label={warning.message}
        />
      ))}
      {replacesFile ? (
        <StatusMark
          tone="idle"
          label="The earlier recovery file no longer opens this circle"
        />
      ) : null}
      <Notes carried={carried} />
    </span>
  );
}

/** The recovery file, handed over as a file: it carries what the circle protects, and is never a packet. */
function FileKey({ name, body }: { name: string; body: string }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="actions">
      <IconKey
        id="tcc-save-file"
        label="Save the recovery file"
        onClick={() => {
          downloadFile(`${name}-recovery.json`, body);
          setSaved(true);
        }}
      >
        <IconDownload size={17} />
      </IconKey>
      {saved ? (
        <StatusMark tone="ok" label="The recovery file was saved" />
      ) : null}
    </div>
  );
}

export function DealtStep({
  desk,
  circleId,
  circleName,
  dealt,
  custody: first,
  carried,
  replacesFile = false,
}: {
  desk: Desk;
  circleId: string;
  circleName: string;
  dealt: Dealt;
  /** Who held a share when the circle was made; receipts add to it. */
  custody: CustodyStatus;
  /** What the recovery file could not carry, when it was just made. */
  carried: Carried | null;
  /** The file made now replaces an earlier one, which no longer opens this circle. */
  replacesFile?: boolean;
}) {
  const [custody, setCustody] = useState(first);
  const recovers = dealt.bundleFile !== null;
  const names = new Map(dealt.welcomes.map((w) => [w.guardianId, w.name]));

  function describeReceipt(packet: Packet): string | null {
    if (packet.kind !== "receipt") return null;
    const name = names.get(packet.value.guardianId);
    return name ? `${name}'s receipt` : null;
  }

  async function receive(text: string): Promise<void> {
    setCustody(await recordReceipt(desk.ports, circleId, text));
    await desk.refresh();
  }

  return (
    <CeremonyShell name="Packets" top={custody.armed ? "Armed" : undefined}>
      <DealtMarks
        dealt={dealt}
        armed={custody.armed}
        replacesFile={replacesFile}
        carried={carried}
      />
      {dealt.bundleFile !== null ? (
        <FileKey name={circleName} body={dealt.bundleFile} />
      ) : null}
      {dealt.welcomes.map((handout) => (
        <HandoutRow
          key={handout.guardianId}
          handout={handout}
          noun="packet"
          holds={recovers ? custody.held.includes(handout.guardianId) : null}
        />
      ))}
      {dealt.notices.map((handout) => (
        <HandoutRow
          key={handout.guardianId}
          handout={handout}
          noun="notice"
          holds={null}
        />
      ))}
      {recovers ? (
        <PacketIn
          id="tcc-receipt"
          label="A contact's receipt"
          kind="receipt"
          commitLabel="Add this receipt"
          describe={describeReceipt}
          onPacket={receive}
        />
      ) : null}
    </CeremonyShell>
  );
}
