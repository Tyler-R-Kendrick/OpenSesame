import {
  assertNotDecoySession,
  currentSyntheticTransition,
  onSyntheticTransition,
} from "../decoy-session.js";

/** Independent live sessions survive real vault lock, never a synthetic realm. */
export function assertLiveRealmAuthority(originalTransition: number): void {
  assertNotDecoySession();
  if (currentSyntheticTransition() !== originalTransition)
    throw new Error("The original live session's real authority retired.");
}

export function captureLiveRealmAuthority(): () => void {
  const transition = currentSyntheticTransition();
  assertLiveRealmAuthority(transition);
  return () => assertLiveRealmAuthority(transition);
}

/** Register only while an independently owned live transport is active. */
export function watchLiveRealmAuthority(retire: () => void): () => void {
  assertNotDecoySession();
  return onSyntheticTransition(retire);
}
