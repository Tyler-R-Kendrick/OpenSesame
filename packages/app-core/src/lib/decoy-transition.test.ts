import { afterEach, beforeEach, expect, it } from "vitest";
import { resetRealmFixture } from "./__tests__/reset-realm-fixture.js";
import {
  currentSyntheticTransition,
  isDecoySession,
  markDecoySession,
  onSyntheticTransition,
} from "./decoy-session.js";

const releases: (() => void)[] = [];
beforeEach(resetRealmFixture);
afterEach(() => {
  for (const release of releases.splice(0)) release();
  resetRealmFixture();
});
it("notifies only committed synthetic entry, isolates failure, and honors unsubscribe", () => {
  const before = currentSyntheticTransition();
  const seen: number[] = [];
  releases.push(
    onSyntheticTransition(() => {
      throw new Error("controlled callback failure");
    }),
  );
  const release = onSyntheticTransition(() => {
    expect(isDecoySession()).toBe(true);
    seen.push(currentSyntheticTransition());
  });
  releases.push(release);
  markDecoySession(false);
  expect(seen).toEqual([]);
  markDecoySession(true);
  expect(seen).toEqual([before + 1]);
  release();
  markDecoySession(true);
  expect(seen).toEqual([before + 1]);
});
it("uses a listener snapshot when one callback registers a successor", () => {
  const seen: string[] = [];
  let registered = false;
  releases.push(
    onSyntheticTransition(() => {
      seen.push("original");
      if (!registered) {
        registered = true;
        releases.push(onSyntheticTransition(() => seen.push("successor")));
      }
    }),
  );
  markDecoySession(true);
  expect(seen).toEqual(["original"]);
  markDecoySession(true);
  expect(seen).toEqual(["original", "original", "successor"]);
});
