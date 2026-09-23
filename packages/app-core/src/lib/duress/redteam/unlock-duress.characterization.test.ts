/**
 * Characterization snapshots for duress unlock fail-closed surfaces.
 *
 * Vitest file snapshots are this repo's Verify equivalent (see
 * docs/testing/test-strategy.md). Update only with `vitest -u` after reading
 * the diff — these pin what a coerced unlock attempt is allowed to observe.
 */

import { describe, expect, it } from "vitest";

const WRONG_SECRET = {
  pin: "That PIN did not unlock the vault.",
  password: "That password did not unlock the vault.",
  passkey: "That passkey did not unlock the vault.",
  totp: "That authenticator code is not valid.",
  recovery: "That recovery code is not valid.",
} as const;

const CONTINUE_POLICY = {
  openPresentations: ["normal", "restricted", "decoy"],
  missPresentations: ["locked", "unchanged"],
  openAction: "createGuest",
  missAction: "WrongPasswordError",
} as const;

describe("duress unlock characterization", () => {
  it("wrong-secret copy is identical across gated roads", () => {
    expect(WRONG_SECRET).toMatchSnapshot();
  });

  it("post-match continue policy stays presentation-shaped", () => {
    expect(CONTINUE_POLICY).toMatchSnapshot();
  });
});
