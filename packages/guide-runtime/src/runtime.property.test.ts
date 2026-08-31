import { GUIDE_LANG_VERSION, GUIDE_LIMITS } from "@opensesame/guide-lang";
import type {
  GuideInstruction,
  GuidePredicateId,
  GuideProgram,
  GuideRouteId,
  GuideSide,
  GuideTargetId,
  GuideWaitEvent,
} from "@opensesame/guide-lang";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createTestClock } from "./clock.js";
import {
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createRecordingRenderer,
} from "./fakes.js";
import { createGuideRuntime } from "./runtime.js";

const TARGETS: readonly GuideTargetId[] = [
  "nav.connections",
  "nav.vault",
  "connections.add",
];
const ROUTES: readonly GuideRouteId[] = ["/", "/connections", "/vault"];
const PREDICATES: readonly (readonly [GuidePredicateId, boolean])[] = [
  ["vault.unlocked", false],
  ["connections.empty", true],
];
const SIDES: readonly (GuideSide | null)[] = [
  "top",
  "right",
  "bottom",
  "left",
  null,
];
const EVENTS: readonly GuideWaitEvent[] = ["activate", "appear", "disappear"];
const MESSAGES: readonly string[] = [
  "Open Connections to begin.",
  "Add lives at the top of the list.",
  "",
];

const RENDERING_KINDS: readonly string[] = [
  "annotate",
  "focus",
  "hint",
  "scroll",
];

const targetArb = fc.constantFrom(...TARGETS);
const routeArb = fc.constantFrom(...ROUTES);
const messageArb = fc.constantFrom(...MESSAGES);
const sideArb = fc.constantFrom(...SIDES);
const timeoutArb = fc.integer({
  min: GUIDE_LIMITS.minTimeoutMs,
  max: GUIDE_LIMITS.maxTimeoutMs,
});

const pointingArb = fc
  .tuple(
    fc.constantFrom("focus", "hint", "annotate"),
    targetArb,
    messageArb,
    sideArb,
  )
  .map(([kind, target, message, side]): GuideInstruction => {
    if (kind === "focus") return { kind: "focus", target, message, side };
    if (kind === "hint") return { kind: "hint", target, message, side };
    return { kind: "annotate", target, message, side };
  });

const waitArb = fc.oneof(
  fc.tuple(targetArb, fc.constantFrom(...EVENTS), timeoutArb).map(
    ([target, event, timeoutMs]): GuideInstruction => ({
      kind: "wait",
      subject: "target",
      target,
      event,
      timeoutMs,
    }),
  ),
  fc.tuple(routeArb, timeoutArb).map(
    ([route, timeoutMs]): GuideInstruction => ({
      kind: "wait",
      subject: "route",
      route,
      timeoutMs,
    }),
  ),
  fc
    .tuple(
      fc.constantFrom("vault.unlocked", "connections.empty"),
      fc.boolean(),
      timeoutArb,
    )
    .map(
      ([predicate, expected, timeoutMs]): GuideInstruction => ({
        kind: "wait",
        subject: "state",
        predicate,
        expected,
        timeoutMs,
      }),
    ),
);

const instructionArb = fc.oneof(
  pointingArb,
  waitArb,
  messageArb.map((message): GuideInstruction => ({ kind: "say", message })),
  messageArb.map((message): GuideInstruction => ({ kind: "success", message })),
  targetArb.map((target): GuideInstruction => ({ kind: "scroll", target })),
  routeArb.map((route): GuideInstruction => ({ kind: "navigate", route })),
);

const terminalArb = fc
  .constantFrom("pause", "end", "none")
  .map((choice): GuideInstruction | null => {
    if (choice === "pause") return { kind: "pause" };
    if (choice === "end") return { kind: "end" };
    return null;
  });

const programArb = fc
  .tuple(
    fc.array(instructionArb, {
      maxLength: GUIDE_LIMITS.maxInstructions - 1,
    }),
    terminalArb,
  )
  .map(
    ([body, terminal]): GuideProgram => ({
      version: GUIDE_LANG_VERSION,
      goal: "connection.create",
      instructions: terminal === null ? body : [...body, terminal],
    }),
  );

describe("createGuideRuntime rendering budget", () => {
  it("never renders more than the trajectory asked for", async () => {
    await fc.assert(
      fc.asyncProperty(programArb, async (program) => {
        const renderer = createRecordingRenderer();
        const clock = createTestClock();
        const runtime = createGuideRuntime({
          renderer,
          clock,
          targets: createFakeTargets(TARGETS, TARGETS),
          routes: createFakeRoutes(ROUTES, "/"),
          state: createFakeState(PREDICATES),
        });

        let settled = false;
        const running = runtime.start(program).then((outcome) => {
          settled = true;
          return outcome;
        });
        // Every wait either resolves at once or outlives its deadline, so a
        // pass per instruction is always enough to drive the run to a close.
        for (
          let pass = 0;
          pass <= GUIDE_LIMITS.maxInstructions && !settled;
          pass += 1
        ) {
          await clock.advance(GUIDE_LIMITS.maxTimeoutMs + 1);
        }
        const outcome = await running;

        const asked = program.instructions.filter((instruction) =>
          RENDERING_KINDS.includes(instruction.kind),
        ).length;
        expect(renderer.renderCalls().length).toBeLessThanOrEqual(asked);
        expect(clock.pending()).toBe(0);
        if (outcome.kind === "failed") {
          // A generated program is always inside every budget and always names
          // registered ids, so the only honest failure left is a deadline.
          expect(outcome.error.code).toBe("GUIDE_TIMEOUT");
        }
      }),
      { numRuns: 100 },
    );
  });
});
