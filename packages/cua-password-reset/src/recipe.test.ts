import { describe, expect, it } from "vitest";
import {
  recipeMatches,
  replayStep,
  resolveStepRef,
  stepDrift,
} from "./recipe.js";
import { ORIGIN, observation, run } from "./test-support.js";

describe("domain recipes", () => {
  it("matches only the exact domain and allowed origin", () => {
    expect(recipeMatches(run().recipe, ORIGIN)).toBe(true);
    expect(
      recipeMatches(run().recipe, "https://sub.accounts.example.test"),
    ).toBe(false);
    expect(recipeMatches(run().recipe, "https://example.test")).toBe(false);
  });

  it("replays without a model and repairs only drift", async () => {
    const recipe = run().recipe;
    const fields = [{ ref: "e1", kind: "email" as const, label: "Email" }];
    expect(await replayStep(recipe, 1, observation(fields))).toEqual({
      status: "ready",
      step: recipe.steps[1],
    });
    let calls = 0;
    const repaired = await replayStep(recipe, 1, observation([]), {
      repair: async ({ step }) => {
        calls++;
        return { ...step, ref: "e9", expectedLabel: "Email address" };
      },
    });
    expect(repaired.status).toBe("review_required");
    expect(calls).toBe(1);
    if (repaired.status !== "review_required")
      throw new Error("repair was not held for review");
    expect(repaired.recipe.review).toBe("candidate");
    expect(repaired.recipe.steps[1]?.ref).toBe("e9");
  });

  it("replays expected labels through the same masking as discovery", async () => {
    const recipe = run().recipe;
    const identify = recipe.steps[1];
    if (!identify) throw new Error("Fixture requires an identifier step");
    recipe.steps[1] = { ...identify, expectedLabel: "[redacted]" };
    const current = {
      ...observation([
        { ref: "e1", kind: "email" as const, label: "person@example.test" },
      ]),
      sensitiveValues: ["person@example.test"],
    };
    expect(await replayStep(recipe, 1, current)).toEqual({
      status: "ready",
      step: recipe.steps[1],
    });
  });

  it("resolves renumbered snapshot refs by unique label and kind", () => {
    const step = {
      id: "identify",
      primitive: "fill-field" as const,
      ref: "e2",
      expectedLabel: "Email",
      purpose: "identifier" as const,
    };
    const renumbered = observation([
      { ref: "e5", kind: "button", label: "Send reset link" },
      { ref: "e6", kind: "email", label: "Email" },
    ]);
    expect(stepDrift(step, renumbered)).toBe(false);
    expect(resolveStepRef(step, renumbered)).toBe("e6");
    const ambiguous = observation([
      { ref: "e5", kind: "email", label: "Email" },
      { ref: "e6", kind: "email", label: "Email" },
    ]);
    expect(stepDrift(step, ambiguous)).toBe(true);
    expect(resolveStepRef(step, ambiguous)).toBeNull();
    const wrongKind = observation([
      { ref: "e6", kind: "password", label: "Email" },
    ]);
    expect(stepDrift(step, wrongKind)).toBe(true);
  });

  it("relocates a recorded masked-password step only when one password field exists", () => {
    const step = {
      id: "password",
      primitive: "fill-field" as const,
      ref: "e9",
      expectedLabel: "[masked password]",
      purpose: "new-password" as const,
    };
    expect(
      resolveStepRef(
        step,
        observation([
          { ref: "e18", kind: "button", label: "Save password" },
          { ref: "e19", kind: "password", label: "New password" },
        ]),
      ),
    ).toBe("e19");
    expect(
      resolveStepRef(
        step,
        observation([
          { ref: "e19", kind: "password", label: "New password" },
          { ref: "e20", kind: "password", label: "Confirm new password" },
        ]),
      ),
    ).toBeNull();
    // A confirm field without "new" in its label is still ambiguous: both
    // recorded masked fills would land on the one "New password" field.
    expect(
      resolveStepRef(
        step,
        observation([
          { ref: "e19", kind: "password", label: "New password" },
          { ref: "e20", kind: "password", label: "Confirm password" },
        ]),
      ),
    ).toBeNull();
    // The stored ref hint does not rescue ambiguity either: after a
    // renumber it may point at the confirm field.
    expect(
      resolveStepRef(
        { ...step, ref: "e19" },
        observation([
          { ref: "e19", kind: "password", label: "Confirm password" },
          { ref: "e20", kind: "password", label: "New password" },
        ]),
      ),
    ).toBeNull();
  });

  it("refuses to rebind a generic masked password label", () => {
    const step = {
      id: "password",
      primitive: "fill-field" as const,
      ref: "e2",
      expectedLabel: "[masked password]",
      purpose: "new-password" as const,
    };
    const changed = observation([
      { ref: "e3", kind: "password", label: "Current password" },
    ]);
    expect(resolveStepRef(step, changed)).toBeNull();
  });

  it("does not let drift repair change the step meaning", async () => {
    await expect(
      replayStep(run().recipe, 1, observation([]), {
        repair: async ({ step }) => ({ ...step, primitive: "submit" }),
      }),
    ).rejects.toThrow("meaning");
  });
});
