/**
 * Settings › Trusted contacts › Guarding (ADR 0186): the circles other people
 * asked this vault's owner to take a part in, each a share of a recovery key
 * or only a seat at the approvals, with whose it is and where it stands.
 *
 * Its head carries the three things a person does as a guardian before they
 * hold anything — accept an invitation, take what an owner sent, answer a
 * request — and each circle's row carries the two it can do for itself:
 * answer a request on it, and leave it. Every one is a sheet.
 */

import {
  type Agreement,
  forgetAgreement,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useState } from "react";
import { byId, useFocusAfter } from "../../lib/use-focus-after.js";
import { useCeremonyFailure } from "./failure-text.js";
import { AcceptSheet } from "./guarding/AcceptSheet.js";
import { GuardingKeys, type HeadSheet } from "./guarding/GuardingKeys.js";
import { GuardingList } from "./guarding/GuardingList.js";
import { LeaveSheet } from "./guarding/LeaveSheet.js";
import { RequestSheet } from "./guarding/RequestSheet.js";
import { TakeSheet } from "./guarding/TakeSheet.js";
import { useAgreements } from "./guarding/use-agreements.js";
import "./guarding/guarding.css";
import { PanelFrame, useSaid } from "./panel-frame.js";
import { countText } from "./row-model.js";
import { type Desk, useDesk } from "./use-desk.js";

type Open =
  | Readonly<{ sheet: "accept" }>
  | Readonly<{ sheet: "take" }>
  | Readonly<{ sheet: "answer"; circleId: string | null }>
  | Readonly<{ sheet: "leave"; circleId: string }>;

/** What a head key opens: the request sheet reads its circle from the request, the others take nothing. */
function opened(sheet: HeadSheet): Open {
  switch (sheet) {
    case "accept":
      return { sheet: "accept" };
    case "take":
      return { sheet: "take" };
    case "answer":
      return { sheet: "answer", circleId: null };
  }
}

function Sheets({
  desk,
  open,
  onChanged,
  onClose,
  onLeft,
}: {
  desk: Desk;
  open: Open | null;
  /** An agreement was made or answered: the list of them is read again. */
  onChanged: () => void;
  onClose: () => void;
  onLeft: () => void;
}) {
  if (open === null) return null;
  if (open.sheet === "accept") {
    return <AcceptSheet desk={desk} onAgreed={onChanged} onClose={onClose} />;
  }
  if (open.sheet === "take") {
    return <TakeSheet desk={desk} onTaken={onChanged} onClose={onClose} />;
  }
  if (open.sheet === "answer") {
    return (
      <RequestSheet desk={desk} circleId={open.circleId} onClose={onClose} />
    );
  }
  const held = desk.held.find(
    (one) => one.seat.signedPolicy.policy.circleId === open.circleId,
  );
  return held ? (
    <LeaveSheet desk={desk} held={held} onLeft={onLeft} onClose={onClose} />
  ) : null;
}

/** What a screen reader is told when the list changes: circles held, and invitations waiting when there are any. */
function counts(held: number, waiting: number): string {
  const circles = `${countText(held, "circle")} held`;
  return waiting === 0 ? circles : `${circles}, ${waiting} waiting`;
}

function Guarding({ desk }: { desk: Desk }) {
  const agreements = useAgreements(desk);
  const said = useSaid(counts(desk.held.length, agreements.agreements.length));
  const [open, setOpen] = useState<Open | null>(null);
  const land = useFocusAfter(false);
  // The failure belongs to the panel, not to a row: the row may be gone by the
  // time the refusal is known, and the tray notice must outlive it.
  const forgetFailure = useCeremonyFailure(
    "trusted-contacts:guarding-forget",
    "Forget an invitation",
  );
  const [forgetting, setForgetting] = useState<string | null>(null);

  async function forget(agreement: Agreement): Promise<boolean> {
    setForgetting(agreement.inviteId);
    const done = await forgetFailure.run(async () => {
      try {
        await forgetAgreement(desk.ports, agreement.inviteId);
      } finally {
        // Whether or not it was there to forget, the list is read as it now
        // is, and the row the Forget key was on may have gone with it. The
        // keyboard is only put back if it was lost.
        await agreements.refresh();
        land(byId("guarding-accept"));
      }
    });
    return done.ok;
  }

  return (
    <PanelFrame
      id="guarding"
      title="Guarding"
      target="settings.trusted-contacts-guarding"
      said={said}
      keys={<GuardingKeys onOpen={(sheet) => setOpen(opened(sheet))} />}
      overlay={
        <Sheets
          desk={desk}
          open={open}
          onChanged={() => void agreements.refresh()}
          onClose={() => setOpen(null)}
          onLeft={() => {
            setOpen(null);
            // The row the Leave key was on has gone with the circle.
            land(byId("guarding-accept"));
          }}
        />
      }
    >
      <GuardingList
        held={desk.held}
        agreements={agreements.agreements}
        failure={agreements.failure}
        forgetFailure={{ inviteId: forgetting, message: forgetFailure.message }}
        onAnswer={(circleId) => setOpen({ sheet: "answer", circleId })}
        onLeave={(circleId) => setOpen({ sheet: "leave", circleId })}
        onForget={forget}
      />
    </PanelFrame>
  );
}

export function GuardingPanel() {
  const desk = useDesk();
  return desk ? <Guarding desk={desk} /> : null;
}
