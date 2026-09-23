import { describe, expect, it } from "vitest";
import { localPrefsEvaluator } from "./evaluate.js";
import {
  type SavedPolicyTest,
  publicationBlocked,
  runSavedPolicyTests,
} from "./policy-tests.js";

describe("saved policy tests", () => {
  it("blocks publication when an allow expectation fails", () => {
    const tests: SavedPolicyTest[] = [
      {
        id: "locked",
        name: "locked vault cannot edit",
        input: {
          resourceId: "prefs",
          principalId: "p",
          operation: "edit",
          facts: { unlocked: false },
          policyRevision: "r1",
        },
        expect: "allow",
      },
    ];
    const runs = runSavedPolicyTests(tests, localPrefsEvaluator);
    expect(runs[0]?.actual).toBe("deny");
    expect(publicationBlocked(runs)).toBe(true);
  });

  it("allows publication when the expected allow holds", () => {
    const tests: SavedPolicyTest[] = [
      {
        id: "open",
        name: "unlocked edit",
        input: {
          resourceId: "prefs",
          principalId: "p",
          operation: "edit",
          facts: { unlocked: true },
          policyRevision: "r1",
        },
        expect: "allow",
      },
    ];
    expect(
      publicationBlocked(runSavedPolicyTests(tests, localPrefsEvaluator)),
    ).toBe(false);
  });
});
