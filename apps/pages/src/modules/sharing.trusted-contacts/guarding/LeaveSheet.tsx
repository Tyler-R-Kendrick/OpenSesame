/**
 * Leaving a circle, the one irreversible act of a guardian (ADR 0186 §10): the
 * share and the seat are forgotten by this device and cannot be taken back
 * without a new welcome from the owner. The card states what goes and that the
 * owner is not told by this; the ordinary danger square with the bin glyph
 * does it, and the sheet's close key is the way out.
 */

import { leaveCircle } from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { HeldRecord } from "@opensesame/app-core/lib/quorum/records.js";
import { keyFingerprint } from "@opensesame/app-core/lib/quorum/request.js";
import { useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconSignOut } from "../../../components/Icons.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { FailureMark, MarkLine } from "./marks.js";
import { useLandWhenSettled } from "./use-land.js";

export function LeaveSheet({
  desk,
  held,
  onLeft,
  onClose,
}: {
  desk: Desk;
  held: HeldRecord;
  /** The circle is gone from this device: the panel closes the sheet and lands the keyboard. */
  onLeft: () => void;
  onClose: () => void;
}) {
  const { policy } = held.seat.signedPolicy;
  const [busy, setBusy] = useState(false);
  const leaveKey = useRef<HTMLButtonElement>(null);
  const failure = useCeremonyFailure(
    "trusted-contacts:guarding-leave",
    "Leave a circle",
  );
  useLandWhenSettled(busy, () => leaveKey.current);

  async function leave(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const done = await failure.run(async () => {
      await leaveCircle(desk.ports, policy.circleId);
      await desk.refresh();
    });
    setBusy(false);
    if (done.ok) onLeft();
  }

  return (
    <CeremonySheet
      title="Leave a circle"
      mark={<IconSignOut size={20} />}
      onClose={onClose}
    >
      <CeremonyShell
        name={policy.label}
        facts={[
          { key: "Held for", value: keyFingerprint(policy.ownerKey) },
          { key: "Holds", value: held.holding ? "a share" : "a seat" },
          { key: "Owner", value: "Not told" },
        ]}
        primary={{
          label: "Leave this circle",
          tone: "danger",
          busy,
          onClick: () => void leave(),
          keyRef: leaveKey,
        }}
      >
        {failure.message ? (
          <MarkLine>
            <FailureMark message={failure.message} />
          </MarkLine>
        ) : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}
