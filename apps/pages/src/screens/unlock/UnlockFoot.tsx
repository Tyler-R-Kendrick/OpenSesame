/**
 * The unlock card's footer. Sign-in instead, on the local seal. The guest
 * tomb beside a sealed vault. Reset, for one vault or this whole browser.
 *
 * The guest link is not on the sign-in panel, and not on a keyless guest
 * tomb — Unlock resumes that tomb, so a second guest control would duplicate
 * it. Governed only by Allow guests (AGENTS.md §5), including beside a guest
 * tomb that enrolled a key.
 */

import { GuestUnlockSwitch } from "./GuestRoad.js";
import { ResetBrowser } from "./ResetBrowser.js";
import { ResetVault } from "./ResetVault.js";

export function UnlockFoot({
  firstRun,
  localOnly,
  onSignInInstead,
  showSignIn,
  showReset,
  busy,
  setBusy,
  setError,
  guestKeyless,
  onOpenReset,
  onDelete,
  onKeep,
}: {
  firstRun: boolean;
  localOnly: boolean;
  onSignInInstead: () => void;
  showSignIn: boolean;
  showReset: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  /** Keyless guest tomb: Unlock resumes it, so the footer link stays off. */
  guestKeyless: boolean;
  onOpenReset: () => void;
  onDelete: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="unlock__foot">
      {firstRun && localOnly ? (
        <button
          type="button"
          className="unlock__switch"
          onClick={onSignInInstead}
        >
          Sign in instead
        </button>
      ) : null}
      {!firstRun && !showSignIn && !showReset ? (
        <GuestUnlockSwitch
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          hidden={guestKeyless}
        />
      ) : null}
      {!firstRun && !showSignIn ? (
        <ResetVault
          open={showReset}
          onOpen={onOpenReset}
          onDelete={onDelete}
          onKeep={onKeep}
        />
      ) : null}
      {showReset ? null : <ResetBrowser />}
    </div>
  );
}
