/**
 * Cancel a request (ADR 0187): the owner pastes the request they want to
 * stop, signs a cancellation with the owner key, and hands the cancellation to
 * every contact who has seen the request. A contact's device that hears of it
 * will not approve or release.
 */

import {
  type Cancelled,
  cancelRequest,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconX } from "../../../components/Icons.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import type { Desk } from "../use-desk.js";
import "./circles.css";

export function CancelSheet({
  desk,
  circleId,
  onClose,
}: {
  desk: Desk;
  circleId: string;
  onClose: () => void;
}) {
  const [done, setDone] = useState<Cancelled | null>(null);
  return (
    <CeremonySheet
      title="Cancel a request"
      mark={<IconX size={20} />}
      onClose={onClose}
    >
      <CeremonyShell name="Cancellation">
        {done ? (
          <>
            <output className="visually-hidden" aria-live="polite">
              Cancellation signed
            </output>
            <PacketOut
              label="Cancellation"
              copyLabel="cancellation"
              packet={done.packet}
            />
          </>
        ) : null}
        <PacketIn
          id="tcc-cancel"
          label="The request to cancel"
          kind="request"
          commitLabel="Sign the cancellation"
          icon={<IconX size={17} />}
          onPacket={async (text) => {
            setDone(await cancelRequest(desk.ports, circleId, text));
          }}
        />
      </CeremonyShell>
    </CeremonySheet>
  );
}
