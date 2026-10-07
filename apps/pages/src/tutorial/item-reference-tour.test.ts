import { ITEM_REFERENCE_GOALS } from "@opensesame/app-core/tutorial/registry/item-reference-goals.js";
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import {
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createGuideRuntime,
  createRecordingRenderer,
  createTestClock,
} from "@opensesame/guide-runtime";
import { describe, expect, it } from "vitest";

const targets = ["item.credentials.references"];

describe("item references tutorial", () => {
  it("reaches its step with Next alone and submits nothing", async () => {
    const goal = ITEM_REFERENCE_GOALS.find(
      (entry) => entry.id === "vault.item.credentials",
    );
    if (!goal) throw new Error("Item references tutorial missing");
    const routes = ["/vault", "/vault/item"];
    const compiled = compileGuide(
      goal.guide,
      { goals: [goal.id], targets, routes, predicates: [] },
      AUTHORED_GUIDE_LIMITS,
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const clock = createTestClock();
    const renderer = createRecordingRenderer();
    const runtime = createGuideRuntime({
      clock,
      renderer,
      routes: createFakeRoutes(routes, "/vault"),
      targets: createFakeTargets(targets, targets),
      state: createFakeState([]),
    });
    const outcome = runtime.start(compiled.program, {
      mode: "tour",
      limits: AUTHORED_GUIDE_LIMITS,
    });
    await clock.advance(0);
    for (let count = 0; count < 5 && runtime.snapshot().tour; count += 1) {
      runtime.next();
      await clock.advance(0);
    }
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
    expect(
      renderer
        .renderCalls()
        .flatMap((call) => (call.kind === "focus" ? [call.target] : [])),
    ).toEqual(targets);
    expect(goal.guide).not.toContain("event=activate");
  });
});
