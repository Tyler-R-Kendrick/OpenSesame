/**
 * Invite more people to a circle that exists (ADR 0187). The invitation and
 * the contacts' answers are the same as when a circle is made; the people who
 * answer join at the next epoch, when the circle is changed. An invitation
 * round already under way is picked up rather than started over, so the
 * people who answered it are not lost.
 */

import {
  type Begun,
  discardDraft,
  inviteMore,
  inviteText,
  readDraft,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Guardian } from "@opensesame/app-core/lib/quorum/types.js";
import { useEffect, useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { IconPlus } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { PeopleStep } from "./PeopleStep.js";
import "./circles.css";

type Round = Readonly<{ begun: Begun; people: readonly Guardian[] }>;

async function round(desk: Desk, circleId: string): Promise<Round> {
  const draft = await readDraft(desk.ports, circleId);
  if (draft) {
    return {
      begun: { draft, invite: inviteText(draft) },
      people: draft.guardians,
    };
  }
  return { begun: await inviteMore(desk.ports, circleId), people: [] };
}

export function InviteMoreSheet({
  desk,
  circleId,
  onClose,
}: {
  desk: Desk;
  circleId: string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<Round | null>(null);
  const failure = useCeremonyFailure(
    "trusted-contacts:invite-more",
    "Invite more people",
  );
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current) return;
    looked.current = true;
    void failure
      .run(() => round(desk, circleId))
      .then((done) => {
        if (done.ok) setCurrent(done.value);
      });
  }, [desk, circleId, failure]);

  function leave(): void {
    if (current && current.people.length === 0) {
      void discardDraft(desk.ports, circleId).catch(() => undefined);
    }
    onClose();
  }

  return (
    <CeremonySheet
      title="Invite more people"
      mark={<IconPlus size={20} />}
      onClose={leave}
    >
      {current ? (
        <PeopleStep
          desk={desk}
          circleId={circleId}
          invite={current.begun.invite}
          facts={[{ key: "Circle", value: current.begun.draft.label }]}
          people={current.people}
          onPeople={(people) => setCurrent({ ...current, people })}
        />
      ) : null}
      {failure.message ? (
        <StatusMark tone="err" label={failure.message} />
      ) : null}
    </CeremonySheet>
  );
}
