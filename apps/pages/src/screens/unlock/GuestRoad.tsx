/**
 * The guest road's placements on the sign-in and unlock screens.
 *
 * Guest is the most common road in, and it has been lost by accident more
 * than once — by gating it on an Identity API, by withholding it beside an
 * existing vault. Neither is legitimate (AGENTS.md §5): `continueAsGuest`
 * seals a local vault with no service at all, and beside a sealed vault the
 * store runs the guest in its own isolated tomb. The one thing that takes
 * these away is the operator's own "Allow guests" switch in Settings ›
 * Capabilities (`guest-access.ts`), which is on unless somebody turned it
 * off. Every placement reads that switch here, so none can drift from it.
 *
 * The guest road lives in two places now — the front door's corner "Skip"
 * and the unlock form's footer "Continue as guest" — and both read the switch.
 * The sign-in panel used to carry a third and fourth copy (a full-size button
 * and a corner Skip); those are gone, so the panel's only no-account road is
 * the local seal ("Use without an account").
 */

import {
  peekGuestArrival,
  takeGuestArrival,
} from "@opensesame/app-core/lib/ceremony-aliases.js";
import { continueAsGuest } from "@opensesame/app-core/lib/guest-auth.js";
import { type RefObject, useEffect, useRef } from "react";
import { useGuestsAllowed } from "../../bindings/guest-access.js";
import { landFocus } from "../../lib/focus.js";

/**
 * A `/guest` link (ADR 0140 D12) lands the keyboard on the guest road the
 * screen drew. It waits a frame so the screen's own landing runs first (the
 * front door's first road, the unlock form's key field), then takes the
 * arrival whether or not the road is drawn: with guests off, the link opens
 * the ordinary sign-in screen and nothing else.
 */
function useGuestArrivalFocus(
  lands = true,
): RefObject<HTMLButtonElement | null> {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!lands || !peekGuestArrival()) return;
    const frame = requestAnimationFrame(() => {
      if (takeGuestArrival()) landFocus(ref.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [lands]);
  return ref;
}

/**
 * First run only: the "Skip" in the card's corner where a skip lives. On the
 * front door it is the one guest placement (ADR 0150 §1), so a `/guest` link
 * `lands` on it there.
 */
export function GuestSkip({
  busy,
  onGuest,
  lands = false,
}: {
  busy: boolean;
  onGuest: () => void;
  lands?: boolean;
}) {
  const ref = useGuestArrivalFocus(lands);
  if (!useGuestsAllowed()) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="unlock__switch signin__skip"
      aria-label="Skip sign-in and continue as guest"
      disabled={busy}
      onClick={onGuest}
    >
      Skip
    </button>
  );
}

/**
 * The unlock form's footer link: whoever holds this device without its key
 * still gets in, as a guest in an isolated tomb, and the sealed vault stays
 * exactly as it is — including beside the guest tomb, where it resumes.
 */
export function GuestUnlockSwitch({
  busy,
  setBusy,
  setError,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
}) {
  const ref = useGuestArrivalFocus();
  if (!useGuestsAllowed()) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="unlock__switch"
      disabled={busy}
      onClick={() => {
        setError(null);
        setBusy(true);
        void continueAsGuest()
          .catch((caught) => {
            setError(
              caught instanceof Error ? caught.message : "Guest login failed.",
            );
          })
          .finally(() => setBusy(false));
      }}
    >
      Continue as guest
    </button>
  );
}
