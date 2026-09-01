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
import { guideGoalIds } from "../../registry/goals.js";
import { GUIDE_ROUTES } from "../../registry/routes.js";
import { guidePredicateIds } from "../../registry/state.js";
import { guideTargetIds } from "../../registry/targets.js";

import { type GuideProgram, compileGuide } from "@opensesame/guide-lang";
import {
  type GuideRouteController,
  type GuideRuntime,
  type RecordingGuideRenderer,
  type TestGuideClock,
  createGuideRuntime,
  createRecordingRenderer,
  createTestClock,
} from "@opensesame/guide-runtime";
import {
  type SupportAgentAvailability,
  type SupportAgentPort,
  type SupportGuideVocabulary,
  type SupportPageContext,
  type SupportRequest,
  type SupportTurn,
  createSupportSession,
  supportVocabulary,
} from "@opensesame/support-agent";
import { buildSupportPageContext } from "../../registry/context.js";
import { registerGuidePredicates } from "../../registry/predicates.js";
import { isKnownGuideRoute } from "../../registry/routes.js";
import {
  isKnownGuidePredicate,
  observeGuidePredicate,
  readGuidePredicate,
} from "../../registry/state.js";
import {
  isKnownGuideTarget,
  isMountedGuideTarget,
  mountGuideTarget,
  observeGuideTarget,
  resolveGuideTargetElement,
} from "../../registry/targets.js";
import { createDriverRenderer } from "../../rendering/driver-renderer.js";
import type { SupportEngine } from "../../session.js";

export const GUIDE_HEADER = "guide/1";

/** Assembles a syntactically well-formed program around one hostile line. */
export function guideSource(...lines: readonly string[]): string {
  return [GUIDE_HEADER, 'goal "vault.lock"', ...lines].join("\n");
}

type RouteWaiter = { readonly route: string; readonly resolve: () => void };

/**
 * The route controller, over the app's real membership check. Navigation is
 * recorded rather than performed: a test asserts on where the runtime asked to
 * go, which is the whole of the authority `navigate` has.
 */
export type RecordingRoutes = GuideRouteController & {
  navigations(): readonly string[];
  /** The person navigated themselves. Not recorded as a guide navigation. */
  go(route: string): void;
};

export function createRecordingRoutes(current: string): RecordingRoutes {
  const navigations: string[] = [];
  const waiters = new Set<RouteWaiter>();
  let at = current;

  const arrive = (route: string): void => {
    at = route;
    for (const waiter of [...waiters]) {
      if (waiter.route !== route) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  return {
    current: () => at,
    isKnown: isKnownGuideRoute,
    navigate: (route) => {
      navigations.push(route);
      arrive(route);
    },
    observe: (route, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        if (at === route) {
          queueMicrotask(resolve);
          return;
        }
        const waiter: RouteWaiter = { route, resolve };
        waiters.add(waiter);
        signal.addEventListener(
          "abort",
          () => {
            waiters.delete(waiter);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }),
    navigations: () => [...navigations],
    go: arrive,
  };
}

export type MountedTargets = {
  /** The live element for a mounted id, so a test can act on the real control. */
  element(id: string): HTMLButtonElement;
  unmount(id: string): void;
  unmountAll(): void;
};

/**
 * Binds real catalog ids to real elements through the real registry. Nothing
 * here invents a target: an id the catalog does not declare makes
 * `mountGuideTarget` throw, which is the behaviour under test elsewhere.
 */
export function mountTargets(
  ids: readonly string[],
  label = "control",
): MountedTargets {
  const elements = new Map<string, HTMLButtonElement>();
  const detachers = new Map<string, () => void>();
  for (const id of ids) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    document.body.appendChild(element);
    elements.set(id, element);
    detachers.set(id, mountGuideTarget(id, element));
  }
  return {
    element(id) {
      const found = elements.get(id);
      if (!found) throw new Error(`no mounted fixture for ${id}`);
      return found;
    },
    unmount(id) {
      detachers.get(id)?.();
      detachers.delete(id);
      elements.get(id)?.remove();
      elements.delete(id);
    },
    unmountAll() {
      for (const detach of detachers.values()) detach();
      detachers.clear();
      for (const element of elements.values()) element.remove();
      elements.clear();
    },
  };
}

export type SupportChain = {
  readonly context: SupportPageContext;
  readonly vocabulary: SupportGuideVocabulary;
  readonly renderer: RecordingGuideRenderer;
  readonly routes: RecordingRoutes;
  readonly clock: TestGuideClock;
  readonly runtime: GuideRuntime;
  readonly targets: MountedTargets;
  /** The app's own compile edge: real compiler, real page vocabulary. */
  compile(source: string): GuideProgram | null;
  dispose(): void;
};

/**
 * The whole chain for one route, with every target that route declares bound
 * to a real element — the most permissive state the application can be in, so
 * a refusal observed here is a refusal by the boundary rather than by the
 * page happening to be empty.
 */
export function createSupportChain(route = "/vault"): SupportChain {
  registerGuidePredicates();
  const context = buildSupportPageContext({
    pageId: "pages",
    route,
    hostReachable: true,
    identityReachable: true,
  });
  const vocabulary = supportVocabulary(context);
  const targets = mountTargets(vocabulary.targets);
  const renderer = createRecordingRenderer();
  const routes = createRecordingRoutes(route);
  const clock = createTestClock();
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

  return {
    context,
    vocabulary,
    renderer,
    routes,
    clock,
    runtime,
    targets,
    compile(source) {
      const result = compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    dispose() {
      runtime.cancel("user");
      targets.unmountAll();
      renderer.reset();
    },
  };
}

/**
 * A provider that answers only when a test tells it to — and that keeps
 * answering after the caller has stopped listening.
 *
 * The abort signal is deliberately ignored. A well-behaved provider settles on
 * abort and proves nothing; the interesting adversary is the one whose answer
 * lands after the vault locked, because that is the moment when a stale
 * continuation would have a torn-down page to draw on.
 */
export type DeferredSupportAgent = SupportAgentPort & {
  pending(): number;
  /**
   * Settles one outstanding run, oldest first by default. The index is what
   * lets a test answer question two before question one — the ordering an
   * out-of-order provider produces and the whole point of a generation check.
   */
  settle(turn: SupportTurn, index?: number): void;
  requests(): readonly SupportRequest[];
  destroyed(): boolean;
};

export function createDeferredSupportAgent(): DeferredSupportAgent {
  const waiting: ((turn: SupportTurn) => void)[] = [];
  const received: SupportRequest[] = [];
  let destroyed = false;

  return {
    availability(): Promise<SupportAgentAvailability> {
      return Promise.resolve({ kind: "ready" });
    },
    run(request: SupportRequest): Promise<SupportTurn> {
      received.push(request);
      return new Promise<SupportTurn>((resolve) => {
        waiting.push(resolve);
      });
    },
    destroy(): void {
      destroyed = true;
    },
    pending: () => waiting.length,
    settle(turn, index = 0) {
      const [resolve] = waiting.splice(index, 1);
      resolve?.(turn);
    },
    requests: () => received.slice(),
    destroyed: () => destroyed,
  };
}

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
