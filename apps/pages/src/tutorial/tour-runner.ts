import type { GuideLimits } from "@opensesame/guide-lang";
import type { GuideOutcome, GuideRuntime } from "@opensesame/guide-runtime";
import type { GuideOrigin } from "./engine.js";

/**
 * The tour controls of an engine, over one runtime.
 *
 * Every guide the browser runs is a tour — a person walks it a step at a
 * time — and only its *origin* decides the budget it was compiled under: an
 * authored tutorial may be longer than a model's trajectory (ADR 0160). The
 * engine and every test engine take these four from here, so the pacing a
 * test observes is the pacing the app has.
 */
export function tourRunner(runtime: GuideRuntime, authored: GuideLimits) {
  return {
    runGuide(
      program: Parameters<GuideRuntime["start"]>[0],
      origin: GuideOrigin,
    ): Promise<GuideOutcome> {
      return runtime.start(
        program,
        origin === "authored"
          ? { mode: "tour", limits: authored }
          : { mode: "tour" },
      );
    },
    nextStep: () => runtime.next(),
    backStep: () => runtime.back(),
    restartGuide: () => runtime.restart(),
  };
}
