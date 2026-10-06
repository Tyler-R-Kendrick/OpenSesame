import { expect, it } from "vitest";
import { leakedSeedPlaintext } from "./plaintext-oracle.test-support.js";

it("ignores coincidental short strings in opaque ciphertext and index bytes", () => {
  const raw = JSON.stringify({
    c: "osr2.AA2026tagsvaultreviewapprovequarterlyZZ",
    x: ["ab2026cd2026ef0123456789abcdef0123"],
  });
  expect(leakedSeedPlaintext(raw)).toEqual([]);
});

it.each([
  { at: "2026-01-01T00:00:00Z" },
  { owner: "user-alice" },
  { comment: "Quarterly vault review for Alice" },
  { tags: ["vault", "review"] },
  { action: "approve" },
  { receipts: [] },
  { id: "r1" },
])("detects actual seeded plaintext fields or complete values: %j", (value) => {
  expect(leakedSeedPlaintext(JSON.stringify(value)).length).toBeGreaterThan(0);
});
