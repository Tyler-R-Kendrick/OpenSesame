/**
 * The packets of a circle that is not yet armed, handed out again (ADR 0186
 * §10): the desk kept what was dealt when the circle was made or changed, so
 * a sheet closed halfway, or a page reloaded, leaves no contact without their
 * packet. It is the same step the circle was made with, read back from what
 * was kept: a packet for each contact, a notice for each who left, the
 * recovery file, and the field their receipts come back to.
 *
 * Once the last receipt is in the desk lets the packets go and the circle's
 * sheet stops offering this; what is on the screen stays until it is closed.
 */

import {
  type CustodyStatus,
  type Dealt,
  custodyStatus,
  readDealt,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useEffect, useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { IconMail } from "../../../components/Icons.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { DealtStep } from "./DealtStep.js";
import "./circles.css";

type Kept = Readonly<{
  dealt: Dealt;
  custody: CustodyStatus;
  name: string;
  epoch: number;
}>;

export function PacketsSheet({
  desk,
  circleId,
  onClose,
}: {
  desk: Desk;
  circleId: string;
  onClose: () => void;
}) {
  const [kept, setKept] = useState<Kept | null>(null);
  const failure = useCeremonyFailure(
    "trusted-contacts:packets-open",
    "Hand out the packets",
  );
  const looked = useRef(false);
  const record = desk.owned.find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  const policy = record?.signedPolicy.policy;

  useEffect(() => {
    if (looked.current || !policy) return;
    looked.current = true;
    void failure
      .run(async () => {
        const dealt = await readDealt(desk.ports, circleId);
        return dealt
          ? {
              dealt,
              custody: await custodyStatus(desk.ports, circleId),
              name: policy.label,
              epoch: policy.epoch,
            }
          : null;
      })
      .then((done) => {
        // Nothing left to hand out: the sheet has nothing to show.
        if (done.ok && done.value === null) onClose();
        else if (done.ok) setKept(done.value);
      });
  }, [desk.ports, circleId, policy, failure, onClose]);

  return (
    <CeremonySheet
      title="Hand out the packets"
      mark={<IconMail size={20} />}
      onClose={onClose}
    >
      {kept ? (
        <DealtStep
          desk={desk}
          circleId={circleId}
          circleName={kept.name}
          dealt={kept.dealt}
          custody={kept.custody}
          carried={null}
          replacesFile={kept.epoch > 1 && kept.dealt.bundleFile !== null}
        />
      ) : null}
    </CeremonySheet>
  );
}
