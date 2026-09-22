/**
 * PRF sign-in protector enrollment / late-callback gate (TRIGGER-D).
 * Narrow adapter over local-passkey-prf — does not mutate vault store hotspots.
 */

export type PresentationClass =
  | "normal"
  | "restricted"
  | "decoy"
  | "locked"
  | "unchanged";

export type PrfSignInGate = Readonly<{
  presentation: PresentationClass;
  /** Local or independent hold active. */
  held: boolean;
  retiredDevice: boolean;
  /** Session generation when the PRF ceremony began. */
  ceremonyGeneration: number;
  /** Current session generation at callback time. */
  currentGeneration: number;
}>;

const BLOCKED: ReadonlySet<PresentationClass> = new Set([
  "restricted",
  "decoy",
  "locked",
]);

export function mayEnrollPrfSignInProtector(gate: PrfSignInGate): boolean {
  if (gate.retiredDevice) return false;
  if (gate.held) return false;
  if (BLOCKED.has(gate.presentation)) return false;
  return true;
}

export function assertMayEnrollPrfSignInProtector(gate: PrfSignInGate): void {
  if (!mayEnrollPrfSignInProtector(gate)) {
    throw new Error(
      "denied_by_incident: PRF sign-in protector enrollment blocked while restricted/held",
    );
  }
}

/**
 * Late WebAuthn/PRF callbacks must re-check the gate and generation.
 * A callback that started before restriction must not enroll after.
 */
export function assertMayApplyLatePrfCallback(gate: PrfSignInGate): void {
  assertMayEnrollPrfSignInProtector(gate);
  if (gate.ceremonyGeneration !== gate.currentGeneration) {
    throw new Error(
      "stale_session: late PRF callback after restriction or generation bump",
    );
  }
}

/**
 * Wrap an async PRF enroll/apply callback with the gate.
 * On deny, the inner function is never invoked (no partial enroll).
 */
export async function withPrfSignInGuard<T>(
  gate: PrfSignInGate,
  phase: "enroll" | "late_callback",
  run: () => Promise<T>,
): Promise<T> {
  if (phase === "late_callback") {
    assertMayApplyLatePrfCallback(gate);
  } else {
    assertMayEnrollPrfSignInProtector(gate);
  }
  return run();
}
