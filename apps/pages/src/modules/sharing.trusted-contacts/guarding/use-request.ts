/**
 * Answering a request, one step at a time: read it against the policy this
 * device holds, say yes to it, and once the delay has passed release a share.
 * The desk decides all of it; this keeps what a screen needs between steps.
 *
 * Everything kept is public: the request packet as pasted (a release needs the
 * same text again), what the desk made of it, and the packets handed back. The
 * share a release opens is the desk's and never reaches this hook.
 */

import {
  DeskError,
  type RequestView,
  approveRequest,
  noteCancellation,
  readRequest,
  releaseShare,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  expectPacket,
  packetKind,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { useState } from "react";
import { type CeremonyFailure, useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";

export type Loaded = Readonly<{ text: string; view: RequestView }>;

export type RequestFlow = Readonly<{
  loaded: Loaded | null;
  /** The owner's cancellation was recorded and no request was on screen to change. */
  noted: boolean;
  approval: string | null;
  release: string | null;
  busy: boolean;
  failure: CeremonyFailure;
  read: (text: string) => Promise<void>;
  approve: () => Promise<void>;
  releaseWith: (approvals: string) => Promise<void>;
}>;

/** A request that names a circle other than the one this sheet was opened for is not this sheet's to answer. */
function assertCircle(text: string, circleId: string | null): void {
  if (circleId === null) return;
  if (expectPacket(text, "request").value.circleId !== circleId) {
    throw new DeskError("other_circle", "this request is for another circle");
  }
}

export function useRequest(desk: Desk, circleId: string | null): RequestFlow {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [noted, setNoted] = useState(false);
  const [approval, setApproval] = useState<string | null>(null);
  const [release, setRelease] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:guarding-approve",
    "Answer a request",
  );

  async function read(text: string): Promise<void> {
    if (packetKind(text) === "cancellation") {
      await noteCancellation(desk.ports, text);
      // The request on screen, if any, is read again: its phase is now over.
      if (loaded) {
        setLoaded({
          text: loaded.text,
          view: await readRequest(desk.ports, loaded.text),
        });
      } else {
        setNoted(true);
      }
      return;
    }
    assertCircle(text, circleId);
    const view = await readRequest(desk.ports, text);
    setLoaded({ text, view });
    setNoted(false);
    setApproval(null);
    setRelease(null);
    failure.clear();
  }

  async function approve(): Promise<void> {
    if (!loaded || busy) return;
    setBusy(true);
    const done = await failure.run(async () => {
      const packet = await approveRequest(desk.ports, loaded.text);
      await desk.refresh();
      return packet;
    });
    setBusy(false);
    if (done.ok) setApproval(done.value);
  }

  async function releaseWith(approvals: string): Promise<void> {
    if (!loaded) return;
    setRelease(
      await releaseShare(desk.ports, { request: loaded.text, approvals }),
    );
    await desk.refresh();
  }

  return {
    loaded,
    noted,
    approval,
    release,
    busy,
    failure,
    read,
    approve,
    releaseWith,
  };
}
