import { describe, expect, it } from "vitest";
import { recipeMatches, replayStep } from "./recipe.js";
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

  it("does not let drift repair change the step meaning", async () => {
    await expect(
      replayStep(run().recipe, 1, observation([]), {
        repair: async ({ step }) => ({ ...step, primitive: "submit" }),
      }),
    ).rejects.toThrow("meaning");
  });
});
