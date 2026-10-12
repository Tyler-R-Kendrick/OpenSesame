/**
 * Where the join ceremony is reached from (ADR 0136): the front door's road,
 * and an invite link, which opens it by itself because the link is the
 * request (ADR 0090 §2). Boot has already taken the link's bearer out of the
 * address bar; this only asks for it once, as the unlock screen mounts.
 *
 * The road is on every deployment (ADR 0150): a live session needs no Host,
 * only the owner's open tab. A Host invite link still opens the Host
 * ceremony (ADR 0136), which says so where it cannot finish.
 */

import { configuredEndpoint } from "@opensesame/app-core/lib/join/client.js";
import {
  type CapturedInvite,
  onInviteArrival,
  takeCapturedInvite,
} from "@opensesame/app-core/lib/join/invite.js";
import { holdLiveLink } from "@opensesame/app-core/lib/live/link.js";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { IconLogin } from "../../components/Icons.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { JoinScreen } from "../JoinScreen.js";
import { LiveJoinGate } from "./LiveJoinGate.js";

export const joinRoadDependencies = {
  configuredEndpoint,
  takeCapturedInvite,
  onInviteArrival,
  /** The lock screens' road. `useJoinRoad` installs it. */
  openJoin: (): void => {},
};

/** `arrival` counts invites, so a new one starts a fresh ceremony. */
type Joining = { captured: CapturedInvite | null; arrival: number } | null;

export type JoinRoadState = Readonly<{
  /** The ceremony, while it is open. */
  screen: ReactNode;
  /** The front door's opener. */
  open: () => void;
}>;

/** The ceremony when it is open, and the road's opener. */
export function useJoinRoad(): JoinRoadState {
  const [joining, setJoining] = useState<Joining>(() => {
    const captured = joinRoadDependencies.takeCapturedInvite();
    if (captured?.kind === "live") holdLiveLink(captured.link);
    return captured ? { captured, arrival: 0 } : null;
  });
  // A link pasted into this open tab arrives without a reload.
  useEffect(
    () =>
      joinRoadDependencies.onInviteArrival(() => {
        const captured = joinRoadDependencies.takeCapturedInvite();
        if (captured) {
          if (captured.kind === "live") holdLiveLink(captured.link);
          setJoining((was) => ({ captured, arrival: (was?.arrival ?? 0) + 1 }));
        }
      }),
    [],
  );
  const open = useCallback(
    () => setJoining({ captured: null, arrival: 0 }),
    [],
  );
  // The vault chooser and the unlock footer call this. A setup record does
  // not retire it: join stays reachable once a vault exists.
  useEffect(() => {
    const previous = joinRoadDependencies.openJoin;
    joinRoadDependencies.openJoin = open;
    return () => {
      if (joinRoadDependencies.openJoin === open) {
        joinRoadDependencies.openJoin = previous;
      }
    };
  }, [open]);
  return {
    screen: joining ? joinScreenFor(joining, () => setJoining(null)) : null,
    // Live sessions need no Host, so the road is on every deployment.
    open,
  };
}

/**
 * `/join` inside the unlocked shell: the command bar and `g j` land here.
 * The gate asks for Live sessions when they are off, then opens `/live`.
 */
export function JoinRoadRoute() {
  const navigate = useNavigate();
  return <LiveJoinGate link={null} onClose={() => navigate("/vault")} />;
}

/**
 * A Host invite (or a leaked one) opens the Host ceremony (ADR 0136); a live
 * link, or the road pressed with nothing in hand, opens the live join
 * (ADR 0150).
 */
function joinScreenFor(joining: NonNullable<Joining>, onDone: () => void) {
  const { captured } = joining;
  if (captured?.kind === "invite" || captured?.kind === "leaked")
    return (
      <JoinScreen
        key={joining.arrival}
        captured={captured}
        configured={joinRoadDependencies.configuredEndpoint()}
        onDone={onDone}
      />
    );
  return (
    <LiveJoinGate
      key={joining.arrival}
      link={captured?.kind === "live" ? captured.link : null}
      onClose={onDone}
    />
  );
}

/** The front door's second road, beside "Set up your own". */
export function JoinRoadButton({
  onOpen,
  variant = "road",
}: {
  onOpen: () => void;
  /** `road` is the card. `foot` is the lock screen's footer link. */
  variant?: "road" | "foot";
}) {
  const joinRef = useGuideTarget<HTMLButtonElement>("setup.join");
  if (variant === "foot") {
    return (
      <button
        ref={joinRef}
        type="button"
        className="unlock__switch"
        aria-label="Join a session"
        title="a link somebody shared"
        onClick={onOpen}
      >
        Join a session
      </button>
    );
  }
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
        a link somebody shared
      </span>
    </button>
  );
}
