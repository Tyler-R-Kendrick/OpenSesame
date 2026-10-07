import { expect, it } from "vitest";
import { decoyControlsAvailable } from "./availability.js";
const owner = {
  status: "unlocked",
  guest: false,
  decoy: false,
  awaitingSecondStep: false,
};
it("shows unsupported owner evidence and recovery states but never a non-owner realm", () => {
  const empty = { traps: [], events: [] };
  expect(decoyControlsAvailable(owner, false, empty)).toBe(false);
  expect(decoyControlsAvailable(owner, true, empty)).toBe(true);
  for (const records of [
    { traps: [{}], events: [] },
    { traps: [], events: [{}] },
    null,
  ]) {
    expect(decoyControlsAvailable(owner, false, records)).toBe(true);
    for (const denied of [
      { ...owner, status: "locked" },
      { ...owner, guest: true },
      { ...owner, decoy: true },
      { ...owner, awaitingSecondStep: true },
    ])
      expect(decoyControlsAvailable(denied, true, records)).toBe(false);
  }
});
