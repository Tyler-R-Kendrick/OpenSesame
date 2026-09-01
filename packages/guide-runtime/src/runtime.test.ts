import { getEventListeners } from "node:events";

import { GUIDE_LANG_VERSION, GUIDE_LIMITS } from "@opensesame/guide-lang";
import type {
  GuideGoalId,
  GuideInstruction,
  GuidePredicateId,
  GuideProgram,
  GuideRouteId,
  GuideTargetId,
} from "@opensesame/guide-lang";
import { describe, expect, it } from "vitest";

import { createTestClock } from "./clock.js";
import type { TestGuideClock } from "./clock.js";
import {
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createRecordingRenderer,
} from "./fakes.js";
import type {
  FakeGuideRoutes,
  FakeGuideState,
  FakeGuideTargets,
  RecordingGuideRenderer,
} from "./fakes.js";
import type {
  GuideOutcome,
  GuideRenderer,
  GuideRuntime,
  GuideRuntimeSnapshot,
  GuideTargetResolver,
} from "./ports.js";
import { GUIDE_RUNTIME_NOTES, createGuideRuntime } from "./runtime.js";

const KNOWN_TARGETS: readonly GuideTargetId[] = [
  "nav.connections",
  "nav.vault",
  "connections.add",
];
const KNOWN_ROUTES: readonly GuideRouteId[] = ["/", "/connections", "/vault"];
const KNOWN_PREDICATES: readonly (readonly [GuidePredicateId, boolean])[] = [
  ["vault.unlocked", false],
];
const GOAL: GuideGoalId = "connection.create";

type Harness = {
  readonly renderer: RecordingGuideRenderer;
  readonly targets: FakeGuideTargets;
  readonly routes: FakeGuideRoutes;
  readonly state: FakeGuideState;
  readonly clock: TestGuideClock;
  readonly runtime: GuideRuntime;
};

function createHarness(
  mounted: readonly GuideTargetId[] = KNOWN_TARGETS,
  route: GuideRouteId = "/",
): Harness {
  const renderer = createRecordingRenderer();
  const targets = createFakeTargets(KNOWN_TARGETS, mounted);
  const routes = createFakeRoutes(KNOWN_ROUTES, route);
  const state = createFakeState(KNOWN_PREDICATES);
  const clock = createTestClock();
  const runtime = createGuideRuntime({
    renderer,
    targets,
    routes,
    state,
    clock,
  });
  return { renderer, targets, routes, state, clock, runtime };
}

function guide(
  instructions: readonly GuideInstruction[],
  goal: GuideGoalId = GOAL,
): GuideProgram {
  return { version: GUIDE_LANG_VERSION, goal, instructions };
}

/** Let every continuation the runtime chained run, without moving the clock. */
async function catchUp(clock: TestGuideClock): Promise<void> {
  await clock.advance(0);
}

/**
 * A resolver that ignores the abort signal and settles whenever the test says
 * so. Real adapters do not behave this way — that is the point: it is how a
 * *stale* continuation gets manufactured, so the runtime's own run-identity
 * guard is what the assertion is measuring.
 */
type LatchedTargets = GuideTargetResolver & {
  release(): void;
};

function createLatchedTargets(): LatchedTargets {
  const releases: (() => void)[] = [];
  return {
    isKnown: () => true,
    isMounted: () => true,
    observe: () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
    release: () => {
      for (const resolve of releases.splice(0)) resolve();
    },
  };
}

describe("createGuideRuntime", () => {
  it("drives the renderer in the order the trajectory declares", async () => {
    const { renderer, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([
        { kind: "say", message: "Connections is where a provider is added." },
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections to begin.",
          side: "right",
        },
        { kind: "scroll", target: "connections.add" },
        {
          kind: "hint",
          target: "connections.add",
          message: "Add lives here.",
          side: null,
        },
        {
          kind: "annotate",
          target: "nav.vault",
          message: "The vault stays locked throughout.",
          side: "top",
        },
        { kind: "success", message: "That is the whole flow." },
        { kind: "end" },
      ]),
    );

    expect(renderer.sequence()).toEqual([
      "focus",
      "scroll",
      "hint",
      "annotate",
      "clear",
    ]);
    expect(renderer.calls[0]).toEqual({
      kind: "focus",
      target: "nav.connections",
      message: "Open Connections to begin.",
      side: "right",
    });
    expect(outcome).toEqual({ kind: "completed", goal: GOAL });
  });

  it("fails closed on a target the registry does not declare", async () => {
    const { renderer, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "This never renders.",
          side: null,
        },
        {
          kind: "focus",
          target: "nav.ghost",
          message: "Nor does this.",
          side: null,
        },
      ]),
    );

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "UNKNOWN_TARGET", detail: "nav.ghost" },
    });
    expect(renderer.calls).toEqual([]);
  });

  it("fails closed on a route the registry does not declare", async () => {
    const { renderer, routes, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([{ kind: "navigate", route: "/admin" }]),
    );

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "UNKNOWN_ROUTE", detail: "/admin" },
    });
    expect(routes.navigations()).toEqual([]);
    expect(renderer.calls).toEqual([]);
  });

  it("fails closed on a predicate the registry does not declare", async () => {
    const { renderer, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([
        {
          kind: "wait",
          subject: "state",
          predicate: "vault.exported",
          expected: true,
          timeoutMs: 30_000,
        },
      ]),
    );

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "UNKNOWN_PREDICATE", detail: "vault.exported" },
    });
    expect(renderer.calls).toEqual([]);
  });

  /**
   * The parser and the runtime both enforce `maxMessageChars`, so they have to
   * be counting the same thing. Counting UTF-16 units here made every astral
   * character cost two, and a message the compiler had already accepted was
   * refused by the runtime it was compiled for.
   */
  it("measures a message in code points, as the parser does", async () => {
    const emoji = "\u{1F510}";
    const atLimit = emoji.repeat(GUIDE_LIMITS.maxMessageChars);
    expect(Array.from(atLimit).length).toBe(GUIDE_LIMITS.maxMessageChars);
    expect(atLimit.length).toBe(GUIDE_LIMITS.maxMessageChars * 2);

    const accepted = createHarness();
    const ok = await accepted.runtime.start(
      guide([{ kind: "say", message: atLimit }, { kind: "end" }]),
    );
    expect(ok.kind).toBe("completed");

    const refused = createHarness();
    const bad = await refused.runtime.start(
      guide([
        {
          kind: "say",
          message: emoji.repeat(GUIDE_LIMITS.maxMessageChars + 1),
        },
        { kind: "end" },
      ]),
    );
    expect(bad.kind).toBe("failed");
    expect(refused.renderer.calls).toEqual([]);
  });

  it("re-enforces the instruction budget instead of trusting the parser", async () => {
    const { renderer, runtime } = createHarness();
    const padding: GuideInstruction = { kind: "say", message: "Padding." };
    const instructions: readonly GuideInstruction[] = [
      {
        kind: "focus",
        target: "nav.connections",
        message: "This never renders.",
        side: null,
      },
      ...Array.from({ length: GUIDE_LIMITS.maxInstructions }, () => padding),
    ];
    expect(instructions.length).toBe(GUIDE_LIMITS.maxInstructions + 1);

    const outcome = await runtime.start(guide(instructions));

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "GUIDE_VALIDATION_ERROR", detail: "maxInstructions" },
    });
    expect(renderer.calls).toEqual([]);
  });

  it("re-enforces the timeout bounds instead of trusting the parser", async () => {
    const { renderer, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "This never renders.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: GUIDE_LIMITS.maxTimeoutMs + 1,
        },
      ]),
    );

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "GUIDE_VALIDATION_ERROR", detail: "timeoutMs" },
    });
    expect(renderer.calls).toEqual([]);
  });

  it("re-enforces the message budget instead of trusting the parser", async () => {
    const { renderer, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "x".repeat(GUIDE_LIMITS.maxMessageChars + 1),
          side: null,
        },
      ]),
    );

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "GUIDE_VALIDATION_ERROR", detail: "maxMessageChars" },
    });
    expect(renderer.calls).toEqual([]);
  });

  it("refuses to point at a known target that is not mounted", async () => {
    const { renderer, runtime } = createHarness(["nav.connections"]);

    const outcome = await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "hint",
          target: "connections.add",
          message: "Add is not on screen.",
          side: null,
        },
      ]),
    );

    expect(renderer.sequence()).toEqual(["focus"]);
    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "TARGET_NOT_MOUNTED", detail: "connections.add" },
    });
  });

  it("times out a wait the clock outlives", async () => {
    const { clock, runtime, targets } = createHarness();
    let settled: GuideOutcome | null = null;
    const running = runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
      ]),
    );
    running.then(
      (outcome) => {
        settled = outcome;
      },
      () => {
        settled = null;
      },
    );
    await catchUp(clock);
    expect(runtime.snapshot().status).toBe("waiting");

    await clock.advance(29_999);
    expect(settled).toBeNull();

    await clock.advance(2);
    expect(await running).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "GUIDE_TIMEOUT", detail: "nav.connections" },
    });
    expect(clock.pending()).toBe(0);
    for (const signal of targets.observedSignals()) {
      expect(signal.aborted).toBe(true);
    }
  });

  it("continues when the wait is satisfied before the deadline", async () => {
    const { clock, renderer, runtime, targets } = createHarness();
    const running = runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
      ]),
    );
    await catchUp(clock);

    targets.activate("nav.connections");

    expect(await running).toEqual({
      kind: "observed",
      goal: GOAL,
      route: "/",
      note: GUIDE_RUNTIME_NOTES.waitSatisfied,
    });
    expect(renderer.sequence()).toEqual(["focus"]);
    // The deadline lost the race and must not still be armed.
    expect(clock.pending()).toBe(0);
  });

  it("accepts the alternate path: a route wait is satisfied by arriving, not by clicking", async () => {
    const { clock, routes, runtime } = createHarness();
    const running = runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "wait",
          subject: "route",
          route: "/connections",
          timeoutMs: 30_000,
        },
      ]),
    );
    await catchUp(clock);

    routes.go("/connections");

    expect(await running).toEqual({
      kind: "observed",
      goal: GOAL,
      route: "/connections",
      note: GUIDE_RUNTIME_NOTES.waitSatisfied,
    });
    expect(routes.navigations()).toEqual([]);
  });

  it("satisfies a state wait when the predicate flips", async () => {
    const { clock, runtime, state } = createHarness();
    const running = runtime.start(
      guide([
        {
          kind: "wait",
          subject: "state",
          predicate: "vault.unlocked",
          expected: true,
          timeoutMs: 30_000,
        },
      ]),
    );
    await catchUp(clock);

    state.set("vault.unlocked", true);

    expect(await running).toEqual({
      kind: "observed",
      goal: GOAL,
      route: "/",
      note: GUIDE_RUNTIME_NOTES.waitSatisfied,
    });
  });

  it("navigates through the route controller and stops at the replan boundary", async () => {
    const { routes, runtime } = createHarness();

    const outcome = await runtime.start(
      guide([
        { kind: "navigate", route: "/connections" },
        {
          kind: "annotate",
          target: "connections.add",
          message: "Add a connection here.",
          side: "bottom",
        },
      ]),
    );

    expect(routes.navigations()).toEqual(["/connections"]);
    expect(outcome).toEqual({
      kind: "observed",
      goal: GOAL,
      route: "/connections",
      note: GUIDE_RUNTIME_NOTES.exhausted,
    });
  });

  it("supersedes the run in flight and ignores its stale continuation", async () => {
    const renderer = createRecordingRenderer();
    const targets = createLatchedTargets();
    const clock = createTestClock();
    const runtime = createGuideRuntime({
      renderer,
      targets,
      routes: createFakeRoutes(KNOWN_ROUTES, "/"),
      state: createFakeState(KNOWN_PREDICATES),
      clock,
    });

    const first = runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "First trajectory.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
        {
          kind: "focus",
          target: "nav.vault",
          message: "Must never render.",
          side: null,
        },
      ]),
    );
    await catchUp(clock);

    const second = runtime.start(
      guide(
        [
          {
            kind: "focus",
            target: "connections.add",
            message: "Second trajectory.",
            side: null,
          },
          { kind: "end" },
        ],
        "vault.unlock",
      ),
    );

    expect(await first).toEqual({
      kind: "cancelled",
      goal: GOAL,
      reason: "superseded",
    });
    expect(await second).toEqual({ kind: "completed", goal: "vault.unlock" });

    const beforeRelease = renderer.sequence();
    const snapshotBeforeRelease = runtime.snapshot();
    targets.release();
    await catchUp(clock);

    expect(renderer.sequence()).toEqual(beforeRelease);
    // The stale continuation renders nothing and mutates no snapshot.
    expect(runtime.snapshot()).toEqual(snapshotBeforeRelease);
    expect(
      renderer.calls.flatMap((call) =>
        call.kind === "clear" ? [] : [call.target],
      ),
    ).toEqual(["nav.connections", "connections.add"]);
    expect(runtime.snapshot().runId).toBe(2);
  });

  it("cancelling for a lock clears the overlays and outlives the late observation", async () => {
    const renderer = createRecordingRenderer();
    const targets = createLatchedTargets();
    const clock = createTestClock();
    const runtime = createGuideRuntime({
      renderer,
      targets,
      routes: createFakeRoutes(KNOWN_ROUTES, "/"),
      state: createFakeState(KNOWN_PREDICATES),
      clock,
    });

    const running = runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
        {
          kind: "focus",
          target: "nav.vault",
          message: "Must never render.",
          side: null,
        },
      ]),
    );
    await catchUp(clock);

    runtime.cancel("lock");

    expect(await running).toEqual({
      kind: "cancelled",
      goal: GOAL,
      reason: "lock",
    });
    expect(renderer.sequence()).toEqual(["focus", "clear"]);
    expect(clock.pending()).toBe(0);

    targets.release();
    await catchUp(clock);

    expect(renderer.sequence()).toEqual(["focus", "clear"]);
    expect(runtime.snapshot().status).toBe("done");
  });

  it("pause leaves the overlays standing and end tears them down", async () => {
    const paused = createHarness();
    const pausedOutcome = await paused.runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        { kind: "pause" },
      ]),
    );
    expect(pausedOutcome).toEqual({ kind: "paused", goal: GOAL });
    expect(paused.renderer.sequence()).toEqual(["focus"]);
    expect(paused.runtime.snapshot().status).toBe("paused");

    const ended = createHarness();
    const endedOutcome = await ended.runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        { kind: "end" },
      ]),
    );
    expect(endedOutcome).toEqual({ kind: "completed", goal: GOAL });
    expect(ended.renderer.sequence()).toEqual(["focus", "clear"]);
  });

  it("pauses a wait from outside, leaving the overlays up", async () => {
    const { clock, renderer, runtime } = createHarness();
    const running = runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
      ]),
    );
    await catchUp(clock);

    runtime.pause();

    expect(await running).toEqual({ kind: "paused", goal: GOAL });
    expect(renderer.sequence()).toEqual(["focus"]);
    expect(clock.pending()).toBe(0);
  });

  it("treats pause and cancel as idempotent, and safe when idle", async () => {
    const { renderer, runtime } = createHarness();

    runtime.pause();
    runtime.pause();
    runtime.cancel("user");
    runtime.cancel("user");
    expect(renderer.calls).toEqual([]);
    expect(runtime.snapshot().status).toBe("idle");

    const outcome = await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        { kind: "pause" },
      ]),
    );
    expect(outcome).toEqual({ kind: "paused", goal: GOAL });

    // A lock tears overlays down even when the last run left them up.
    runtime.cancel("lock");
    runtime.cancel("lock");
    expect(renderer.sequence()).toEqual(["focus", "clear", "clear"]);
    expect(runtime.snapshot().status).toBe("done");
  });

  it("publishes a coherent snapshot sequence and stops on unsubscribe", async () => {
    const { clock, runtime, targets } = createHarness();
    const seen: GuideRuntimeSnapshot[] = [];
    const unsubscribe = runtime.subscribe({
      onSnapshot: (snapshot) => {
        seen.push(snapshot);
      },
    });

    expect(runtime.snapshot()).toEqual({
      status: "idle",
      goal: null,
      index: 0,
      total: 0,
      runId: 0,
      message: null,
      error: null,
    });

    const running = runtime.start(
      guide([
        { kind: "say", message: "Here is the plan." },
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
        { kind: "success", message: "Done." },
        { kind: "end" },
      ]),
    );
    await catchUp(clock);
    targets.activate("nav.connections");
    await running;

    expect(seen.map((snapshot) => snapshot.status)).toEqual([
      "running",
      "running",
      "waiting",
      "running",
      "running",
      "done",
    ]);
    expect(seen.map((snapshot) => snapshot.index)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(seen.every((snapshot) => snapshot.runId === 1)).toBe(true);
    expect(seen.every((snapshot) => snapshot.total === 5)).toBe(true);
    expect(seen[0]?.message).toBe("Here is the plan.");
    expect(seen[5]?.message).toBe("Done.");
    expect(runtime.snapshot()).toEqual(seen[5]);

    const delivered = seen.length;
    unsubscribe();
    await runtime.start(guide([{ kind: "say", message: "Unheard." }]));
    expect(seen.length).toBe(delivered);
    expect(runtime.snapshot().runId).toBe(2);
  });

  it("carries the failure into the snapshot", async () => {
    const { runtime } = createHarness();

    await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.ghost",
          message: "Nowhere.",
          side: null,
        },
      ]),
    );

    expect(runtime.snapshot().status).toBe("failed");
    expect(runtime.snapshot().error).toEqual({
      code: "UNKNOWN_TARGET",
      detail: "nav.ghost",
    });
  });

  it("leaves no armed deadline and no abort listener behind", async () => {
    const { clock, runtime, targets } = createHarness();
    const program = guide([
      {
        kind: "wait",
        subject: "target",
        target: "nav.connections",
        event: "activate",
        timeoutMs: 30_000,
      },
    ]);

    const timedOut = runtime.start(program);
    await catchUp(clock);
    await clock.advance(30_000);
    await timedOut;

    const satisfied = runtime.start(program);
    await catchUp(clock);
    targets.activate("nav.connections");
    await satisfied;

    const cancelled = runtime.start(program);
    await catchUp(clock);
    runtime.cancel("navigation");
    await cancelled;
    await catchUp(clock);

    expect(clock.pending()).toBe(0);
    const signals = targets.observedSignals();
    expect(signals.length).toBe(3);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(getEventListeners(signal, "abort").length).toBe(0);
    }
  });

  it("settles every path without an unhandled rejection", async () => {
    const rejections: string[] = [];
    const onUnhandled = (): void => {
      rejections.push("unhandled");
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { clock, runtime, targets } = createHarness();
      const waiting = guide([
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
      ]);

      await runtime.start(
        guide([
          { kind: "focus", target: "nav.ghost", message: "No.", side: null },
        ]),
      );

      const timedOut = runtime.start(waiting);
      await catchUp(clock);
      await clock.advance(30_000);
      await timedOut;

      const superseded = runtime.start(waiting);
      await catchUp(clock);
      const replacement = runtime.start(guide([{ kind: "end" }]));
      await superseded;
      await replacement;

      const cancelled = runtime.start(waiting);
      await catchUp(clock);
      runtime.cancel("lock");
      await cancelled;
      targets.activate("nav.connections");

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(rejections).toEqual([]);
  });

  it("stops at an observation boundary when a wait can no longer be observed", async () => {
    const renderer = createRecordingRenderer();
    const targets: GuideTargetResolver = {
      isKnown: () => true,
      isMounted: () => true,
      observe: () => Promise.reject(new Error("adapter detached")),
    };
    const runtime = createGuideRuntime({
      renderer,
      targets,
      routes: createFakeRoutes(KNOWN_ROUTES, "/vault"),
      state: createFakeState(KNOWN_PREDICATES),
      clock: createTestClock(),
    });

    const outcome = await runtime.start(
      guide([
        {
          kind: "wait",
          subject: "target",
          target: "nav.connections",
          event: "activate",
          timeoutMs: 30_000,
        },
      ]),
    );

    expect(outcome).toEqual({
      kind: "observed",
      goal: GOAL,
      route: "/vault",
      note: GUIDE_RUNTIME_NOTES.unobservable,
    });
  });

  it("settles rather than throwing when a renderer throws", async () => {
    const renderer: GuideRenderer = {
      focus: () => Promise.reject(new Error("driver detached")),
      hint: () => Promise.resolve(),
      annotate: () => Promise.resolve(),
      scroll: () => Promise.resolve(),
      clear: () => {},
    };
    const runtime = createGuideRuntime({
      renderer,
      targets: createFakeTargets(KNOWN_TARGETS, KNOWN_TARGETS),
      routes: createFakeRoutes(KNOWN_ROUTES, "/"),
      state: createFakeState(KNOWN_PREDICATES),
      clock: createTestClock(),
    });

    const outcome = await runtime.start(
      guide([
        {
          kind: "focus",
          target: "nav.connections",
          message: "Open Connections.",
          side: null,
        },
      ]),
    );

    expect(outcome).toEqual({
      kind: "failed",
      goal: GOAL,
      error: { code: "GUIDE_VALIDATION_ERROR", detail: "runtime" },
    });
  });
});
