/**
 * The front door — the first screen of a device with no vault (ADR 0115,
 * ADR 0150 §1).
 *
 * A first visitor arrives to do one of two things, and the door offers
 * exactly those, large: **set up your own** vault, or **join a session**
 * somebody shared. Sign-in is a question for a device that holds a vault, so
 * the door does not ask it; once setup has been answered or skipped the
 * sign-in screen is the first screen. Nothing is put in front of the roads
 * (ADR 0090), and the guest road stays one press away as the card's **Skip**
 * (AGENTS.md §5, governed only by the operator's "Allow guests" switch).
 *
 * The title is the wordmark itself, at hero scale: the same slot-reel every
 * gate runs, big enough to be the one authored moment of the screen. Nothing
 * else here moves.
 *
 * The keyboard lands on the first road; Tab walks to the second, and Skip
 * sits in the card's corner where a skip always lives.
 */

import { clearAuthOutcome } from "@opensesame/app-core/lib/auth-outcome.js";
import { continueAsGuest } from "@opensesame/app-core/lib/guest-auth.js";
import { useEffect, useRef, useState } from "react";
import { FailureNotice } from "../components/FailureNotice.js";
import { GateTools } from "../components/GateTools.js";
import { IconAuthority } from "../components/Icons.js";
import { StatusMark } from "../components/StatusMark.js";
import { Wordmark } from "../components/Wordmark.js";
import { landFocus } from "../lib/focus.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { RequirementsGate } from "./capabilities/RequirementsGate.js";
import { JoinRoadButton } from "./join/JoinRoad.js";
import { GuestSkip } from "./unlock/GuestRoad.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
import { ReleaseNotes } from "./unlock/ReleaseNotes.js";
import "./unlock.css";
import "./door.css";

export function FrontDoor({
  onOpenSetup,
  onOpenJoin,
}: {
  /** The operator ceremony — every tab of it optional (ADR 0114). `join`
   *  lands on a managed instance's required roots to accept. */
  onOpenSetup: (join?: boolean) => void;
  /** Join a session: a live one browser to browser (ADR 0150), or a Host's. */
  onOpenJoin: () => void;
}) {
  useSupportRoute("/unlock/door");
  const setupRef = useGuideTarget<HTMLButtonElement>("unlock.setup");
  const firstRoad = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [guestFailed, setGuestFailed] = useState<string | null>(null);

  // The screen owns its landing: the first road, so Enter opens it and Tab
  // walks the rest.
  useEffect(() => {
    landFocus(firstRoad.current);
  }, []);

  function startGuest(): void {
    setGuestFailed(null);
    setBusy(true);
    clearAuthOutcome();
    void continueAsGuest()
      .catch((caught) =>
        setGuestFailed(
          caught instanceof Error ? caught.message : "Guest login failed.",
        ),
      )
      .finally(() => setBusy(false));
  }

  return (
    <div className="unlock door">
      <div className="unlock__card door__card">
        {/* The anonymous road, in the card's corner where a skip lives
            (AGENTS.md §5). */}
        <GuestSkip busy={busy} onGuest={startGuest} lands />
        <PendingLinkBanner />
        <header className="door__hero">
          <Wordmark as="h1" className="door__wordmark" size={40} />
          <p className="door__lede">Set up your own vault, or join one.</p>
        </header>

        {/* A managed instance's required roots, when this deployment has
            any nobody has accepted yet. Never in front of sign-in. */}
        <RequirementsGate onOpenSetup={onOpenSetup} />

        <fieldset className="door__roads" aria-label="Roads in">
          {/* The name is the road; the second line describes it, so a
              screen reader hears "Set up your own" and then what it takes. */}
          <button
            ref={(element) => {
              firstRoad.current = element;
              setupRef(element);
            }}
            type="button"
            className="road"
            aria-label="Set up your own"
            aria-describedby="door-setup-kind"
            onClick={() => onOpenSetup()}
          >
            <span className="road__mark" aria-hidden="true">
              <IconAuthority size={20} />
            </span>
            <span className="road__name">Set up your own</span>
            <span className="road__kind" id="door-setup-kind">
              a few optional steps
            </span>
          </button>
          <JoinRoadButton onOpen={onOpenJoin} />
        </fieldset>

        <div className="door__theme">
          <GateTools tabIndex={-1} />
        </div>

        {guestFailed ? <StatusMark tone="err" label={guestFailed} /> : null}
        <FailureNotice
          id="front-door:guest"
          title="Guest"
          message={guestFailed}
        />
      </div>
      <ReleaseNotes />
    </div>
  );
}
