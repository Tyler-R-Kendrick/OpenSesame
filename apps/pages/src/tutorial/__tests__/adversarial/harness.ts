import { buildSupportPageContext } from "@opensesame/app-core/tutorial/registry/context.js";
import { guideGoalIds } from "@opensesame/app-core/tutorial/registry/goals.js";
import { registerGuidePredicates } from "@opensesame/app-core/tutorial/registry/predicates.js";
import { GUIDE_ROUTES } from "@opensesame/app-core/tutorial/registry/routes.js";
import {
  guidePredicateIds,
  isKnownGuidePredicate,
  observeGuidePredicate,
  readGuidePredicate,
} from "@opensesame/app-core/tutorial/registry/state.js";
import {
  guideTargetIds,
  isKnownGuideTarget,
  isMountedGuideTarget,
  observeGuideTarget,
  resolveGuideTargetElement,
} from "@opensesame/app-core/tutorial/registry/targets.js";
/**
 * The composed chain these suites attack.
 *
 * Every per-package suite drives one component against fakes for its
 * neighbours. That is the right shape for those suites and it is exactly why
 * the seams between the components are the least-observed part of this
 * feature: a component can satisfy its own contract while the wiring around it
 * quietly widens what reaches the DOM. So the harness below assembles the real
 * page context, the real compiler, the real registries and the real runtime,
 * and offers only two observation points — what the renderer was asked to
 * draw, and where the router was asked to go. An attack that leaves both empty
 * left no trace on the page.
 */
import { compileGuide } from "@opensesame/guide-lang";
import {
  type GuideRuntime,
  type TestGuideClock,
  createGuideRuntime,
  createTestClock,
} from "@opensesame/guide-runtime";
import {
  type SupportAgentPort,
  type SupportPageContext,
  createSupportSession,
  supportVocabulary,
} from "@opensesame/support-agent";
import { createDriverRenderer } from "../../rendering/driver-renderer.js";
import type { SupportEngine } from "../../session.js";
import {
  type MountedTargets,
  type RecordingRoutes,
  createRecordingRoutes,
  mountTargets,
} from "./chain.js";

export {
  GUIDE_HEADER,
  type DeferredSupportAgent,
  type MountedTargets,
  type RecordingRoutes,
  type SupportChain,
  createDeferredSupportAgent,
  createRecordingRoutes,
  createSupportChain,
  guideSource,
  mountTargets,
} from "./chain.js";

export type DomEngine = SupportEngine & {
  readonly routes: RecordingRoutes;
  readonly clock: TestGuideClock;
  readonly targets: MountedTargets;
  readonly runtime: GuideRuntime;
  readonly context: SupportPageContext;
  destroyed(): boolean;
};

/**
 * The engine `apps/pages` actually builds, minus the provider: the real
 * Driver.js renderer over the real target registry, the real compiler over the
 * real page vocabulary, and the real support session. Only the model and the
 * clock are substituted, because neither can be driven deterministically.
 */
export function createDomEngine(
  port: SupportAgentPort,
  route = "/vault",
): DomEngine {
  registerGuidePredicates();
  const context = buildSupportPageContext({
    pageId: "pages",
    route,
    hostReachable: true,
    identityReachable: true,
  });
  const vocabulary = supportVocabulary(context);
  const targets = mountTargets(vocabulary.targets);
  const routes = createRecordingRoutes(route);
  const clock = createTestClock();
  const renderer = createDriverRenderer({
    resolveElement: resolveGuideTargetElement,
    reducedMotion: () => true,
  });
  const runtime = createGuideRuntime({
    renderer,
    targets: {
      isKnown: isKnownGuideTarget,
      isMounted: isMountedGuideTarget,
      observe: observeGuideTarget,
    },
    routes,
    state: {
      isKnown: isKnownGuidePredicate,
      read: readGuidePredicate,
      observe: observeGuidePredicate,
    },
    clock,
  });
  const session = createSupportSession({
    port,
    vocabulary,
    readContext: () => context,
  });
  let destroyed = false;

  return {
    transport: "on-device",
    warning: null,
    session,
    routes,
    clock,
    targets,
    runtime,
    context,
    compile(source) {
      const result = compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    // Authored walkthroughs compile against the whole registry, as they do in
    // the app: a cross-route guide names a control on the screen it is about to
    // navigate to, which the route-scoped vocabulary cannot contain.
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
    acquire: () => Promise.resolve({ kind: "acquired" }),
    destroy() {
      destroyed = true;
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
    },
    destroyed: () => destroyed,
  };
}

/** Overlay nodes the guide renderer owns, counted straight off the document. */
export const OVERLAY_SELECTOR =
  ".driver-popover, .driver-overlay, .driver-active-element, [data-os-guide-annotation]";

export function liveOverlayCount(): number {
  return document.querySelectorAll(OVERLAY_SELECTOR).length;
}

/**
 * Drains the macrotask queue as well as the microtask one. The renderer loads
 * Driver.js through a dynamic import, so a microtask-only flush would observe
 * a page that has not drawn yet and call it proof of nothing rendering.
 */
export async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Polls a condition across macrotasks, so a test never sleeps on a guess. */
export async function waitUntil(
  condition: () => boolean,
  attempts = 400,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition never held");
}
