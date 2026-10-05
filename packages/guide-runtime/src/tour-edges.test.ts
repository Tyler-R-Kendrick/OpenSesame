import { GUIDE_LANG_VERSION } from "@opensesame/guide-lang";
import type {
  GuideGoalId,
  GuideInstruction,
  GuideProgram,
  GuideRouteId,
  GuideTargetId,
} from "@opensesame/guide-lang";
import { describe, expect, it } from "vitest";

import { createTestClock } from "./clock.js";
import {
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createRecordingRenderer,
} from "./fakes.js";
import { createGuideRuntime } from "./runtime.js";

const TARGETS: readonly GuideTargetId[] = ["vault.create", "vault.export"];
const ROUTES: readonly GuideRouteId[] = ["/vault", "/settings"];
const GOAL: GuideGoalId = "vault.item.create";

function program(instructions: readonly GuideInstruction[]): GuideProgram {
  return { version: GUIDE_LANG_VERSION, goal: GOAL, instructions };
}

const POINTING: readonly GuideInstruction[] = [
  { kind: "say", message: "Items are sealed on this device." },
  {
    kind: "focus",
    target: "vault.create",
    message: "This opens the editor.",
    side: "bottom",
  },
  { kind: "success", message: "That is the tour." },
  { kind: "end" },
];

function harness(mounted: readonly GuideTargetId[] = TARGETS) {
  const clock = createTestClock();
  const routes = createFakeRoutes(ROUTES, "/vault");
  const runtime = createGuideRuntime({
    renderer: createRecordingRenderer(),
    targets: createFakeTargets(TARGETS, mounted),
    routes,
    state: createFakeState([["vault.unlocked", true]]),
    clock,
  });
  const settle = async () => {
    await clock.advance(0);
  };
  return { routes, runtime, settle };
}

describe("tour mode edges", () => {
  it("does not skip a step when Next arrives while its control is awaited", async () => {
    const h = harness([]);
    void h.runtime.start(program(POINTING), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    expect(h.runtime.snapshot().tour?.step).toBe(2);
    // A second press inside the grace window only stops the waiting.
    h.runtime.next();
    await h.settle();
    expect(h.runtime.snapshot().tour).toMatchObject({
      step: 2,
      degraded: true,
    });
    expect(h.runtime.snapshot().status).toBe("waiting");
  });

  it("still lets Back leave a step that is awaiting its control", async () => {
    const h = harness([]);
    void h.runtime.start(program(POINTING), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    h.runtime.back();
    await h.settle();
    expect(h.runtime.snapshot().tour?.step).toBe(1);
  });

  it("runs the trailing preamble of a synthetic close", async () => {
    const h = harness();
    const outcome = h.runtime.start(
      program([
        { kind: "say", message: "One." },
        { kind: "navigate", route: "/settings" },
        { kind: "end" },
      ]),
      { mode: "tour" },
    );
    await h.settle();
    expect(h.routes.current()).toBe("/vault");
    h.runtime.next();
    await h.settle();
    expect(h.routes.current()).toBe("/settings");
    h.runtime.next();
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
  });

  it("waits through the trailing wait of a synthetic close", async () => {
    const h = harness();
    void h.runtime.start(
      program([
        { kind: "navigate", route: "/settings" },
        {
          kind: "wait",
          subject: "route",
          route: "/settings",
          timeoutMs: 15_000,
        },
        { kind: "end" },
      ]),
      { mode: "tour" },
    );
    await h.settle();
    expect(h.routes.current()).toBe("/settings");
    expect(h.runtime.snapshot().status).toBe("waiting");
  });
});
