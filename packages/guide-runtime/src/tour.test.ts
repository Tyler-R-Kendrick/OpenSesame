import {
  AUTHORED_GUIDE_LIMITS,
  GUIDE_LANG_VERSION,
  GUIDE_LIMITS,
} from "@opensesame/guide-lang";
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
import { planGuideSteps } from "./plan.js";
import type { GuideRuntimeSnapshot } from "./ports.js";
import { createGuideRuntime } from "./runtime.js";
import { TOUR_APPEAR_GRACE_MS } from "./tour.js";

const TARGETS: readonly GuideTargetId[] = ["vault.create", "vault.export"];
const ROUTES: readonly GuideRouteId[] = ["/vault", "/settings"];
const GOAL: GuideGoalId = "vault.item.create";

function program(instructions: readonly GuideInstruction[]): GuideProgram {
  return { version: GUIDE_LANG_VERSION, goal: GOAL, instructions };
}

const TOUR: readonly GuideInstruction[] = [
  { kind: "say", message: "Items are sealed on this device." },
  { kind: "navigate", route: "/vault" },
  {
    kind: "focus",
    target: "vault.create",
    message: "This opens the editor.",
    side: "bottom",
  },
  {
    kind: "wait",
    subject: "target",
    target: "vault.create",
    event: "activate",
    timeoutMs: 30_000,
  },
  { kind: "navigate", route: "/settings" },
  {
    kind: "hint",
    target: "vault.export",
    message: "Export lives here.",
    side: null,
  },
  { kind: "success", message: "That is the tour." },
  { kind: "end" },
];

function harness(mounted: readonly GuideTargetId[] = TARGETS) {
  const renderer = createRecordingRenderer();
  const targets = createFakeTargets(TARGETS, mounted);
  const routes = createFakeRoutes(ROUTES, "/vault");
  const clock = createTestClock();
  const runtime = createGuideRuntime({
    renderer,
    targets,
    routes,
    state: createFakeState([["vault.unlocked", true]]),
    clock,
  });
  const seen: GuideRuntimeSnapshot[] = [];
  runtime.subscribe({ onSnapshot: (snapshot) => seen.push(snapshot) });
  const settle = async () => {
    await clock.advance(0);
  };
  return { renderer, targets, routes, clock, runtime, seen, settle };
}

describe("planGuideSteps", () => {
  it("groups a flat program into the steps a person counts", () => {
    const plan = planGuideSteps(program(TOUR));
    expect(plan.stepCount).toBe(3);
    expect(plan.beats.map((beat) => beat.kind)).toEqual([
      "narrate",
      "point",
      "point",
      "close",
    ]);
    const [, create, exportBeat, close] = plan.beats;
    // The wait straight after a step belongs to that step.
    expect(create?.until).toMatchObject({
      subject: "target",
      event: "activate",
    });
    expect(create?.end).toBe(4);
    // A navigate between two steps is the *next* step's preamble.
    expect(exportBeat?.start).toBe(4);
    expect(exportBeat?.route).toBe("/settings");
    expect(close?.message).toBe("That is the tour.");
  });

  it("closes a program that has no success on a synthetic beat", () => {
    const plan = planGuideSteps(
      program([{ kind: "say", message: "One." }, { kind: "end" }]),
    );
    expect(plan.stepCount).toBe(1);
    expect(plan.beats.at(-1)).toMatchObject({ kind: "close", message: null });
  });

  it("reads a mid-program success as an ordinary step", () => {
    const plan = planGuideSteps(
      program([
        { kind: "success", message: "Early." },
        { kind: "say", message: "Late." },
      ]),
    );
    expect(plan.beats.map((beat) => beat.kind)).toEqual([
      "narrate",
      "narrate",
      "close",
    ]);
  });
});

describe("tour mode", () => {
  it("holds on every step until Next, with Next available on each", async () => {
    const h = harness();
    const outcome = h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();

    const steps: string[] = [];
    for (let guard = 0; guard < 8; guard += 1) {
      const tour = h.runtime.snapshot().tour;
      if (tour === null) break;
      steps.push(`${tour.kind}:${tour.step}/${tour.count}`);
      expect(h.runtime.snapshot().status).toBe("waiting");
      h.runtime.next();
      await h.settle();
    }
    expect(steps).toEqual([
      "narrate:1/3",
      "point:2/3",
      "point:3/3",
      "close:3/3",
    ]);
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
    expect(h.runtime.snapshot().status).toBe("done");
    expect(h.runtime.snapshot().tour).toBeNull();
  });

  it("does not leave a step on its own, however long a person reads", async () => {
    const h = harness();
    void h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    await h.clock.advance(10 * 60_000);
    expect(h.runtime.snapshot().status).toBe("waiting");
    expect(h.runtime.snapshot().tour?.step).toBe(1);
  });

  it("moves on by itself when the person does what the step points at", async () => {
    const h = harness();
    void h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    expect(h.runtime.snapshot().tour).toMatchObject({
      step: 2,
      action: true,
      target: "vault.create",
    });
    h.targets.activate("vault.create");
    await h.settle();
    expect(h.runtime.snapshot().tour).toMatchObject({
      step: 3,
      target: "vault.export",
    });
  });

  it("goes Back, restores the screen its step expects, and Replays", async () => {
    const h = harness();
    void h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    h.runtime.next();
    await h.settle();
    expect(h.routes.current()).toBe("/settings");
    expect(h.runtime.snapshot().tour?.canBack).toBe(true);

    h.runtime.back();
    await h.settle();
    expect(h.runtime.snapshot().tour?.step).toBe(2);
    expect(h.routes.current()).toBe("/vault");

    h.runtime.restart();
    await h.settle();
    expect(h.runtime.snapshot().tour).toMatchObject({
      step: 1,
      canBack: false,
    });
  });

  it("never goes Back past the first step", async () => {
    const h = harness();
    void h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.back();
    await h.settle();
    expect(h.runtime.snapshot().tour?.step).toBe(1);
  });

  it("shows a step whose control is missing as text instead of failing", async () => {
    const h = harness([]);
    const outcome = h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    // The control gets a moment to appear before the step gives up on it.
    expect(h.runtime.snapshot().tour?.degraded).toBe(false);
    await h.clock.advance(TOUR_APPEAR_GRACE_MS);
    expect(h.runtime.snapshot().tour).toMatchObject({
      step: 2,
      degraded: true,
    });
    expect(h.renderer.renderCalls()).toEqual([]);
    h.runtime.next();
    await h.settle();
    h.runtime.cancel("user");
    await expect(outcome).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("points at a control that appears during the grace period", async () => {
    const h = harness([]);
    void h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    h.targets.appear("vault.create");
    await h.settle();
    expect(h.runtime.snapshot().tour?.degraded).toBe(false);
    expect(h.renderer.renderCalls().map((call) => call.kind)).toContain(
      "focus",
    );
  });

  it("drops a command that arrives while no step is listening", async () => {
    const h = harness();
    h.runtime.next();
    h.runtime.back();
    const outcome = h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    expect(h.runtime.snapshot().tour?.step).toBe(1);
    h.runtime.cancel("user");
    await outcome;
  });

  it("clears the previous step's overlay before drawing the next", async () => {
    const h = harness();
    void h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    h.runtime.next();
    await h.settle();
    const sequence = h.renderer.sequence().join(",");
    expect(sequence).toMatch(/clear.*focus.*clear.*hint/);
  });

  it("leaves nothing listening after the person exits", async () => {
    const h = harness();
    const outcome = h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    h.runtime.next();
    await h.settle();
    h.runtime.cancel("user");
    await expect(outcome).resolves.toMatchObject({
      kind: "cancelled",
      reason: "user",
    });
    for (const signal of [
      ...h.targets.observedSignals(),
      ...h.routes.observedSignals(),
    ]) {
      expect(signal.aborted).toBe(true);
    }
    h.runtime.next();
    expect(h.runtime.snapshot().status).toBe("done");
  });

  it("is a no-op in auto mode", async () => {
    const h = harness();
    const outcome = h.runtime.start(
      program([{ kind: "say", message: "Hello." }, { kind: "end" }]),
    );
    h.runtime.next();
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
  });

  it("still refuses a program over the budget it was started under", async () => {
    const long: GuideInstruction[] = Array.from(
      { length: GUIDE_LIMITS.maxInstructions + 1 },
      (_, index) => ({ kind: "say", message: `Step ${index}.` }),
    );
    const refused = harness();
    await expect(
      refused.runtime.start(program(long), { mode: "tour" }),
    ).resolves.toMatchObject({
      kind: "failed",
      error: { code: "GUIDE_VALIDATION_ERROR", detail: "maxInstructions" },
    });

    const allowed = harness();
    const outcome = allowed.runtime.start(program(long), {
      mode: "tour",
      limits: AUTHORED_GUIDE_LIMITS,
    });
    await allowed.settle();
    expect(allowed.runtime.snapshot().tour?.count).toBe(long.length);
    allowed.runtime.cancel("user");
    await outcome;
  });
});

describe("what a tour leaves behind", () => {
  it("carries the closing sentence for the transcript, and no step's", async () => {
    const h = harness();
    const outcome = h.runtime.start(program(TOUR), { mode: "tour" });
    await h.settle();
    expect(h.runtime.snapshot().message).toBeNull();
    for (let step = 0; step < 3; step += 1) {
      h.runtime.next();
      await h.settle();
    }
    expect(h.runtime.snapshot().tour?.kind).toBe("close");
    expect(h.runtime.snapshot().message).toBe("That is the tour.");
    h.runtime.next();
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
    expect(h.runtime.snapshot().message).toBe("That is the tour.");
  });
});

describe("a wait that is already true", () => {
  it("does not skip the step it follows, and is not offered as a move", async () => {
    const h = harness();
    // The person is already on /vault: `wait route "/vault"` holds as the
    // step is drawn, so the step holds for Next like any other.
    const outcome = h.runtime.start(
      program([
        { kind: "say", message: "You are here." },
        { kind: "wait", subject: "route", route: "/vault", timeoutMs: 15_000 },
        { kind: "success", message: "Done." },
      ]),
      { mode: "tour" },
    );
    await h.settle();
    await h.clock.advance(1000);
    expect(h.runtime.snapshot().tour).toMatchObject({
      kind: "narrate",
      step: 1,
      action: false,
    });
    h.runtime.cancel("user");
    await outcome;
  });

  it("advances by itself once the person makes it true", async () => {
    const h = harness();
    void h.runtime.start(
      program([
        {
          kind: "focus",
          target: "vault.create",
          message: "Open settings.",
          side: null,
        },
        {
          kind: "wait",
          subject: "route",
          route: "/settings",
          timeoutMs: 15_000,
        },
        { kind: "success", message: "Arrived." },
      ]),
      { mode: "tour" },
    );
    await h.settle();
    expect(h.runtime.snapshot().tour).toMatchObject({ step: 1, action: true });
    h.routes.go("/settings");
    await h.settle();
    expect(h.runtime.snapshot().tour?.kind).toBe("close");
  });
});
