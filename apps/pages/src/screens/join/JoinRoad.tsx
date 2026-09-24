/**
 * Where the join ceremony is reached from (ADR 0136): the front door's road,
 * and an invite link, which opens it by itself because the link is the
 * request (ADR 0090 §2). Boot has already taken the link's bearer out of the
 * address bar; this only asks for it once, as the unlock screen mounts.
 *
 * On a deployment that cannot finish a join the road is not drawn — a
 * control that can only fail is not offered (ADR 0090). An invite link still
 * opens the ceremony there, which says so without spending the invite.
 */

import {
  configuredEndpoint,
  joinAvailable,
} from "@opensesame/app-core/lib/join/client.js";
import {
  type CapturedInvite,
  onInviteArrival,
  takeCapturedInvite,
} from "@opensesame/app-core/lib/join/invite.js";
import { type ReactNode, useEffect, useState } from "react";
import { IconLogin } from "../../components/Icons.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { JoinScreen } from "../JoinScreen.js";

export const joinRoadDependencies = {
  joinAvailable,
  configuredEndpoint,
  takeCapturedInvite,
  onInviteArrival,
};

/** `arrival` counts invites, so a new one starts a fresh ceremony. */
type Joining = { captured: CapturedInvite | null; arrival: number } | null;

export type JoinRoadState = Readonly<{
  /** The ceremony, while it is open. */
  screen: ReactNode;
  /** The front door's opener — absent where a join cannot be finished. */
  open: (() => void) | undefined;
}>;

/** The ceremony when it is open, and the road's opener when it may be. */
export function useJoinRoad(): JoinRoadState {
  const [joining, setJoining] = useState<Joining>(() => {
    const captured = joinRoadDependencies.takeCapturedInvite();
    return captured ? { captured, arrival: 0 } : null;
  });
  // A link pasted into this open tab arrives without a reload.
  useEffect(
    () =>
      joinRoadDependencies.onInviteArrival(() => {
        const captured = joinRoadDependencies.takeCapturedInvite();
        if (captured)
          setJoining((was) => ({ captured, arrival: (was?.arrival ?? 0) + 1 }));
      }),
    [],
  );
  return {
    screen: joining ? (
      <JoinScreen
        key={joining.arrival}
        captured={joining.captured}
        configured={joinRoadDependencies.configuredEndpoint()}
        onDone={() => setJoining(null)}
      />
    ) : null,
    open: joinRoadDependencies.joinAvailable()
      ? () => setJoining({ captured: null, arrival: 0 })
      : undefined,
  };
}

/** The front door's second road, beside "Set up your own". */
export function JoinRoadButton({ onOpen }: { onOpen?: () => void }) {
  const joinRef = useGuideTarget<HTMLButtonElement>("setup.join");
  if (!onOpen) return null;
  return (
    <button
      ref={joinRef}
      type="button"
      className="road"
      aria-label="Join a session"
      aria-describedby="door-join-kind"
      onClick={onOpen}
    >
      <span className="road__mark" aria-hidden="true">
        <IconLogin size={20} />
      </span>
      <span className="road__name">Join a session</span>
      <span className="road__kind" id="door-join-kind">
        an invite, or an open endpoint
      </span>
    </button>
  );
}
