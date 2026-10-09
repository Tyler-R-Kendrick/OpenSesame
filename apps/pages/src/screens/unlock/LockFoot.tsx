/**
 * Join and "Reset this browser?" on a lock screen that already has a vault
 * (the chooser and the unlock form). Join is the front door's road: a setup
 * record does not take it away.
 */

import { JoinRoadButton, joinRoadDependencies } from "../join/JoinRoad.js";
import { ResetBrowser } from "./ResetBrowser.js";

export function LockFoot({
  variant = "road",
  hideReset = false,
}: {
  /** The chooser draws the card. The unlock form draws the footer link. */
  variant?: "road" | "foot";
  /** The vault-delete sheet is the only erase question while it is open. */
  hideReset?: boolean;
}) {
  return (
    <>
      <JoinRoadButton
        variant={variant}
        onOpen={() => joinRoadDependencies.openJoin()}
      />
      {hideReset ? null : <ResetBrowser />}
    </>
  );
}
