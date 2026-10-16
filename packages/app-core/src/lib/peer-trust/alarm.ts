/** Root-trust fingerprint alarms for the unlocked PWA (D7-2 d). */

export type RootTrustAlarm =
  | { kind: "none" }
  | { kind: "changed"; previous: string; current: string }
  | { kind: "unreadable" };

export function compareRootTrustFingerprint(
  remembered: string | undefined,
  current: string | undefined,
): RootTrustAlarm {
  if (!current) {
    return { kind: "unreadable" };
  }
  if (!remembered) {
    return { kind: "none" };
  }
  if (remembered === current) {
    return { kind: "none" };
  }
  return { kind: "changed", previous: remembered, current };
}
