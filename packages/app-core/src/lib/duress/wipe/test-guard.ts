/**
 * Installed by both workspaces' test setups: the real wipe is forbidden, and a
 * test that reached it fails when it ends (see `guard.ts`).
 */

import { afterEach, expect } from "vitest";
import { wipeGuard } from "./guard.js";

export function installWipeGuard(): void {
  wipeGuard.forbid();
  afterEach(() => {
    const reached = wipeGuard.takeReached();
    wipeGuard.forbid();
    expect(
      reached,
      "a test reached the real wipe runner; inject a fake store or call allowRealWipe()",
    ).toEqual([]);
  });
}

/** For the one suite that wipes for real: opt in for this test, and only this one. */
export function allowRealWipe(): void {
  wipeGuard.allow();
}
