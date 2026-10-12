/**
 * The unlock form's footer: the roads off it that are not the key.
 *
 * First run offers the way back to sign-in, unless a file is waiting for the
 * vault (ADR 0188), which is sealed here and nowhere else. Beside a sealed
 * vault it offers the guest tomb and the question for a key that is forgotten;
 * the sign-in panel and a keyless guest tomb draw neither (AGENTS.md §5).
 */

import { GuestUnlockSwitch } from "./GuestRoad.js";
import { LockFoot } from "./LockFoot.js";
import { ResetVault } from "./ResetVault.js";

export function UnlockFoot({
  firstRun,
  offerSignIn,
  showSignIn,
  showReset,
  guestKeyless,
  busy,
  setBusy,
  setError,
  onSignIn,
  onAskReset,
  onKeepVault,
  onDeleteVault,
}: {
  firstRun: boolean;
  /** First run, sealing locally, and no file is waiting: sign-in is one press back. */
  offerSignIn: boolean;
  showSignIn: boolean;
  showReset: boolean;
  guestKeyless: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  onSignIn: () => void;
  onAskReset: () => void;
  onKeepVault: () => void;
  onDeleteVault: () => void;
}) {
  return (
    <div className="unlock__foot">
      {offerSignIn ? (
        <button type="button" className="unlock__switch" onClick={onSignIn}>
          Sign in instead
        </button>
      ) : null}
      {/* Guest tomb beside a sealed vault (GuestRoad.tsx). Not on
            sign-in or a keyless tomb — Unlock resumes that tomb. Allow
            guests is the only gate (AGENTS.md §5). */}
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
          onOpen={onAskReset}
          onDelete={onDeleteVault}
          onKeep={onKeepVault}
        />
      ) : null}
      <LockFoot variant="foot" hideReset={showReset} />
    </div>
  );
}
