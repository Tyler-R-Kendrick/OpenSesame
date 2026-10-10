/**
 * Ask contacts to approve a share (ADR 0186): the owner names who the share is
 * for and what of, the circle's contacts approve with their own security keys,
 * and when enough have and the delay has passed the share is written to
 * Access › Shares. A request in flight is kept, so it can be reopened after a
 * reload.
 */

import {
  type AskView,
  askStatus,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useEffect, useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { IconShare } from "../../../components/Icons.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { AskCollect } from "./AskCollect.js";
import { AskCompose } from "./AskCompose.js";
import { useLandOnChange } from "./circle-focus.js";
import "./circles.css";

export function AskSheet({
  desk,
  circleId,
  digest,
  onClose,
}: {
  desk: Desk;
  circleId: string;
  /** A request already made, to pick up where it stands. */
  digest?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<AskView | null>(null);
  const [ready, setReady] = useState(digest === undefined);
  const region = useRef<HTMLDivElement>(null);
  const failure = useCeremonyFailure("trusted-contacts:ask-open", "Request");
  const contacts =
    desk.owned.find((r) => r.signedPolicy.policy.circleId === circleId)
      ?.signedPolicy.policy.guardians.length ?? 0;

  const looked = useRef(false);
  useEffect(() => {
    if (digest === undefined || looked.current) return;
    looked.current = true;
    void failure
      .run(() => askStatus(desk.ports, digest))
      .then((done) => {
        if (done.ok) setView(done.value);
        setReady(true);
      });
  }, [digest, desk.ports, failure]);

  useLandOnChange(view ? "collect" : "compose", region);
  return (
    <CeremonySheet
      title="Ask contacts to approve a share"
      mark={<IconShare size={20} />}
      onClose={onClose}
    >
      <div ref={region}>
        {!ready ? null : view ? (
          <AskCollect
            desk={desk}
            view={view}
            onView={setView}
            contacts={contacts}
          />
        ) : (
          <AskCompose desk={desk} circleId={circleId} onAsked={setView} />
        )}
      </div>
    </CeremonySheet>
  );
}
