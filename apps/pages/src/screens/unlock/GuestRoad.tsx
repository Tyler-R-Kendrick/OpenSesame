/**
 * The guest road's placements on the front door and the unlock form.
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
 * One pattern, two placements, both reading the switch. The front door's
 * corner says "Skip". Beside a sealed vault the unlock footer says "Skip to
 * the guest vault" — the same tomb, not a second sign-in phrase. The sign-in
 * panel carries neither: its only no-account road is the local seal ("Use
 * without an account"). A keyless guest tomb does not draw the footer link
 * either; Unlock on that screen already resumes the tomb.
 */

import {
  peekGuestArrival,
  takeGuestArrival,
} from "@opensesame/app-core/lib/ceremony-aliases.js";
import { continueAsGuest } from "@opensesame/app-core/lib/guest-auth.js";
import { useCallback, useEffect, useRef } from "react";
import { useGuestsAllowed } from "../../bindings/guest-access.js";
import { landFocus } from "../../lib/focus.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

/** Beside a sealed vault: the guest tomb, in the unlock form's footer. */
export const GUEST_VAULT_LINK = "Skip to the guest vault";

/**
 * A `/guest` link (ADR 0140 D12) lands the keyboard on the guest road the
 * screen drew. It waits a frame so the screen's own landing runs first (the
 * front door's first road, the unlock form's key field), then takes the
 * arrival whether or not the road is drawn: with guests off, the link opens
 * the ordinary sign-in screen and nothing else.
 */
function useGuestArrivalFocus(
  lands = true,
): (node: HTMLButtonElement | null) => void {
  const ref = useRef<HTMLButtonElement | null>(null);
  // The same button is what a tutorial points at (`unlock.guest`, ADR 0166).
  const target = useGuideTarget<HTMLButtonElement>("unlock.guest");
  const bind = useCallback(
    (node: HTMLButtonElement | null) => {
      ref.current = node;
      target(node);
    },
    [target],
  );
  useEffect(() => {
    if (!lands || !peekGuestArrival()) return;
    const frame = requestAnimationFrame(() => {
      if (takeGuestArrival()) landFocus(ref.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [lands]);
  return bind;
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
 * exactly as it is. A guest tomb that enrolled a key keeps the link; a
 * keyless one does not, because Unlock on that screen resumes the tomb.
 */
export function GuestUnlockSwitch({
  busy,
  setBusy,
  setError,
  hidden = false,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  /**
   * Keyless guest tomb: Unlock resumes that tomb, so drawing this link
   * beside it would be a second guest road. The arrival is still taken, so
   * a `/guest` link cannot surface later on another screen.
   */
  hidden?: boolean;
}) {
  const ref = useGuestArrivalFocus();
  if (!useGuestsAllowed() || hidden) return null;
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
      {GUEST_VAULT_LINK}
    </button>
  );
}
