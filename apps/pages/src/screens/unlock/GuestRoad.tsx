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
 */

import { continueAsGuest } from "@opensesame/app-core/lib/guest-auth.js";
import { useGuestsAllowed } from "../../bindings/guest-access.js";
import { IconUser } from "../../components/Icons.js";

/** The full-size button beside the social bar, on both sign-in placements. */
export function GuestButton({
  busy,
  onGuest,
}: {
  busy: boolean;
  onGuest: () => void;
}) {
  if (!useGuestsAllowed()) return null;
  return (
    <button
      type="button"
      className="btn btn--block signin__provider"
      disabled={busy}
      onClick={onGuest}
    >
      <IconUser size={18} />
      Continue as guest
    </button>
  );
}

/** First run only: the "Skip" in the card's corner where a skip lives. */
export function GuestSkip({
  busy,
  onGuest,
}: {
  busy: boolean;
  onGuest: () => void;
}) {
  if (!useGuestsAllowed()) return null;
  return (
    <button
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
  if (!useGuestsAllowed()) return null;
  return (
    <button
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
