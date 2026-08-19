/**
 * The claim bearer between steps of the ceremony, bound to this app's storage
 * choice: session storage keeps it to this tab and clears when the tab closes,
 * and it stays out of the URL so it cannot be read from the address bar or
 * history. The logic itself is shared — see `@opensesame/ceremony-kit`, where
 * the storage is injected precisely because Pages must make a stricter choice.
 */
import {
  type ClaimStash,
  type StashStorage,
  createClaimStash,
} from "@opensesame/ceremony-kit";

export type { ClaimStash };

const stash = createClaimStash(() => {
  try {
    // ast-grep-ignore: ts-localstorage-set
    return sessionStorage as unknown as StashStorage;
  } catch {
    // Storage is unavailable; the ceremony still works in a single sitting.
    return null;
  }
});

export function writeClaimStash(next: ClaimStash): void {
  stash.write(next);
}

/** Forget the bearer: on completion, on sign-out, and once it cannot be used. */
export function clearClaimStash(): void {
  stash.clear();
}

export function readClaimStash(): ClaimStash | null {
  return stash.read();
}
