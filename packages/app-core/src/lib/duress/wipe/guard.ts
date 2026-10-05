/**
 * The one switch between a test and a real wipe (ADR 0167).
 *
 * The wipe runner removes every vault in this browser's storage. A unit test
 * that reaches it by accident, through an unmocked unlock path, would delete
 * whatever origin files the test host holds. The test setups of both
 * workspaces forbid the real runner (`test-guard.ts`), so the runner refuses
 * and *records* that it was reached: a refusal alone would be swallowed by the
 * effect seam, which never lets a runner throw, and the test would pass for the
 * wrong reason. The setup's `afterEach` fails any test that left a record.
 *
 * A suite that really means to wipe opts in by name (`allowRealWipe`). In a
 * browser nothing forbids it, and the only road to the runner is a matched
 * code at the unlock screen.
 */

const state = { forbidden: false, reached: [] as string[] };

export const wipeGuard = {
  /** Refuse, and remember, until `allow`. Called by the test setups. */
  forbid(): void {
    state.forbidden = true;
  },
  /** Opt in. A test that calls this has said it wants the real removal. */
  allow(): void {
    state.forbidden = false;
  },
  /** Whether `site` may run the real removal; a refusal is recorded. */
  permits(site: string): boolean {
    if (!state.forbidden) return true;
    state.reached.push(site);
    return false;
  },
  /** The sites that were refused since the last call; empties the record. */
  takeReached(): string[] {
    return state.reached.splice(0);
  },
};
