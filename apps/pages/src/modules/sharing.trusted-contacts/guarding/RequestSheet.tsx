/**
 * Answering a request on a circle this device guards, as a ceremony in a sheet
 * (ADR 0187 §10). The guardian pastes the request; the card that follows is
 * what the guardian's own device made of it, read against the signed policy it
 * holds: the sentence built from the request's own fields comes first, because
 * it is the thing being approved, then the recipient and the key to check by
 * another road, the timings, and where it stands. The paste field stays, so an
 * owner's cancellation can be pasted into the same sheet and the card changes
 * with it.
 *
 * Approving touches a key and ends in an approval to hand on. Releasing a
 * share is a second step, offered only after the delay and only to a device
 * that holds a share; it takes the approvals gathered so far, checks them
 * itself, and ends in a release to hand on.
 */

import { type RefObject, useRef } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconSearch, IconShare } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import type { Desk } from "../use-desk.js";
import { mayRelease, phaseMark, requestFacts } from "./guarding-model.js";
import { FailureMark, MarkLine, Marked } from "./marks.js";
import {
  closeKeyOf,
  copyKeyIn,
  firstOf,
  useLandOnChange,
  useLandWhenSettled,
} from "./use-land.js";
import { type Loaded, type RequestFlow, useRequest } from "./use-request.js";

function ReleaseStep({ flow }: { flow: RequestFlow }) {
  if (flow.release !== null) {
    return (
      <PacketOut
        label="Your release"
        copyLabel="your release"
        packet={flow.release}
      />
    );
  }
  return (
    <PacketIn
      id="guarding-approvals"
      label="The approvals so far"
      kind={["approvals", "approval"]}
      commitLabel="Release my share"
      icon={<IconShare size={17} />}
      onPacket={flow.releaseWith}
    />
  );
}

function RequestCard({
  flow,
  loaded,
  body,
}: {
  flow: RequestFlow;
  loaded: Loaded;
  body: RefObject<HTMLDivElement | null>;
}) {
  const { view } = loaded;
  const approveKey = useRef<HTMLButtonElement>(null);
  const canApprove = view.phase === "approve" && flow.approval === null;
  useLandWhenSettled(flow.busy, () => approveKey.current);
  useLandOnChange(`${flow.approval === null}-${flow.release === null}`, () =>
    firstOf(
      copyKeyIn(body.current, "your release"),
      copyKeyIn(body.current, "your approval"),
      closeKeyOf(body.current),
    ),
  );
  return (
    <CeremonyShell
      name={view.summary}
      facts={requestFacts(view)}
      primary={
        canApprove
          ? {
              label: "Approve",
              busy: flow.busy,
              onClick: () => void flow.approve(),
              keyRef: approveKey,
            }
          : undefined
      }
    >
      <MarkLine>
        <Marked mark={phaseMark(view.phase)} />
        <FailureMark message={flow.failure.message} />
      </MarkLine>
      {flow.approval !== null ? (
        <PacketOut
          label="Your approval"
          copyLabel="your approval"
          packet={flow.approval}
        />
      ) : null}
      {mayRelease(view) ? <ReleaseStep flow={flow} /> : null}
    </CeremonyShell>
  );
}

export function RequestSheet({
  desk,
  circleId,
  onClose,
}: {
  desk: Desk;
  /** The circle the sheet was opened for, or `null` when the request names it. */
  circleId: string | null;
  onClose: () => void;
}) {
  const flow = useRequest(desk, circleId);
  const body = useRef<HTMLDivElement>(null);
  return (
    <CeremonySheet
      title="Answer a request"
      mark={<IconSearch size={20} />}
      onClose={onClose}
    >
      <div ref={body}>
        <PacketIn
          id="guarding-request"
          label="A request"
          kind={["request", "cancellation"]}
          commitLabel="Read this"
          onPacket={flow.read}
        />
        {flow.noted ? (
          <MarkLine>
            <StatusMark tone="ok" label="Cancellation noted" />
          </MarkLine>
        ) : null}
        {flow.loaded ? (
          <RequestCard flow={flow} loaded={flow.loaded} body={body} />
        ) : null}
      </div>
    </CeremonySheet>
  );
}
