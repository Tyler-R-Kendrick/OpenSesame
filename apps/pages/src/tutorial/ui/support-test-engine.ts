import { compileGuide } from "@opensesame/guide-lang";
import {
  type FakeGuideRoutes,
  type FakeGuideTargets,
  type RecordingGuideRenderer,
  type TestGuideClock,
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createGuideRuntime,
  createRecordingRenderer,
  createTestClock,
} from "@opensesame/guide-runtime";
import {
  type FakeSupportAgent,
  createSupportSession,
  supportVocabulary,
} from "@opensesame/support-agent";
import { buildSupportPageContext } from "../registry/context.js";
import { guideGoalIds } from "../registry/goals.js";
import { GUIDE_ROUTES } from "../registry/routes.js";
import { guidePredicateIds } from "../registry/state.js";
import { guideTargetIds } from "../registry/targets.js";
import type { SupportEngine, SupportTransport } from "../session.js";

/**
 * The engine every test drives: the real support session, the real guide
 * runtime and the real compiler, over the package's recording fakes. Nothing
 * is mocked — the seam below swaps one whole engine for another, which is what
 * lets these tests assert on the composition rather than on stubs.
 */
export type TestEngine = SupportEngine & {
  readonly renderer: RecordingGuideRenderer;
  readonly targets: FakeGuideTargets;
  readonly routes: FakeGuideRoutes;
  readonly clock: TestGuideClock;
  readonly agent: FakeSupportAgent;
  destroyed(): boolean;
};

export function buildEngine(
  agent: FakeSupportAgent,
  transport: SupportTransport = "on-device",
  warning: string | null = null,
): TestEngine {
  const context = buildSupportPageContext({
    pageId: "test",
    route: "/vault",
    hostReachable: true,
    identityReachable: true,
  });
  const vocabulary = supportVocabulary(context);
  const session = createSupportSession({
    port: agent,
    vocabulary,
    // Re-read per question, as the app does: the written help a model is
    // shown is retrieved for what was asked.
    readContext: (question) =>
      buildSupportPageContext({
        pageId: "test",
        route: "/vault",
        hostReachable: true,
        identityReachable: true,
        question,
      }),
  });
  const renderer = createRecordingRenderer();
  const targets = createFakeTargets(vocabulary.targets, vocabulary.targets);
  const routes = createFakeRoutes(vocabulary.routes, "/vault");
  const clock = createTestClock();
  const runtime = createGuideRuntime({
    renderer,
    targets,
    routes,
    state: createFakeState([]),
    clock,
  });
  let destroyed = false;

  return {
    transport,
    warning,
    session,
    renderer,
    targets,
    routes,
    clock,
    agent,
    compile(source) {
      const result = compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    // Authored walkthroughs compile against the whole registry, as they do in
    // the app.
    compileAuthored(source) {
      const result = compileGuide(source, {
        goals: guideGoalIds(),
        targets: guideTargetIds(),
        routes: GUIDE_ROUTES.map((route) => route.id),
        predicates: guidePredicateIds(),
      });
      return result.ok ? result.program : null;
    },
    runGuide: (program) => runtime.start(program),
    pauseGuide: () => runtime.pause(),
    cancelGuide: (reason) => runtime.cancel(reason),
    subscribeGuide: (listener) => runtime.subscribe({ onSnapshot: listener }),
    async acquire(onProgress) {
      onProgress(0.5);
      agent.setAvailability({ kind: "ready" });
      return { kind: "acquired" };
    },
    destroy() {
      destroyed = true;
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
    },
    destroyed: () => destroyed,
  };
}
