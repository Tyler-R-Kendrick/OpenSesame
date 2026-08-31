/**
 * Recording port fakes.
 *
 * The runtime has no seam to swap and no module to mock — it is a function of
 * its ports — so these fakes are the whole test substrate, for this package
 * and for the browser adapters in `apps/pages` that have to prove they drive
 * the same state machine.
 */

import type {
  GuidePredicateId,
  GuideRouteId,
  GuideSide,
  GuideTargetId,
  GuideWaitEvent,
} from "@opensesame/guide-lang";

import type {
  GuideAnnotateRequest,
  GuideFocusRequest,
  GuideHintRequest,
  GuideRenderer,
  GuideRouteController,
  GuideScrollRequest,
  GuideStateObserver,
  GuideTargetResolver,
} from "./ports.js";

export type RecordedRendererCall =
  | {
      readonly kind: "annotate" | "focus" | "hint";
      readonly target: GuideTargetId;
      readonly message: string;
      readonly side: GuideSide | null;
    }
  | { readonly kind: "scroll"; readonly target: GuideTargetId }
  | { readonly kind: "clear" };

export type RecordingGuideRenderer = GuideRenderer & {
  /** Every call in order, `clear` included. */
  readonly calls: readonly RecordedRendererCall[];
  /** Calls that put something on screen — the budget the runtime may not exceed. */
  renderCalls(): readonly RecordedRendererCall[];
  /** Ordered call kinds, the assertion most tests actually want. */
  sequence(): readonly string[];
  reset(): void;
};

export function createRecordingRenderer(): RecordingGuideRenderer {
  const calls: RecordedRendererCall[] = [];
  const pointed = (
    kind: "annotate" | "focus" | "hint",
    request: GuideFocusRequest,
  ): Promise<void> => {
    calls.push({
      kind,
      target: request.target,
      message: request.message,
      side: request.side,
    });
    return Promise.resolve();
  };

  return {
    calls,
    renderCalls: () => calls.filter((call) => call.kind !== "clear"),
    sequence: () => calls.map((call) => call.kind),
    reset: () => {
      calls.length = 0;
    },
    focus: (request: GuideFocusRequest) => pointed("focus", request),
    hint: (request: GuideHintRequest) => pointed("hint", request),
    annotate: (request: GuideAnnotateRequest) => pointed("annotate", request),
    scroll: (request: GuideScrollRequest) => {
      calls.push({ kind: "scroll", target: request.target });
      return Promise.resolve();
    },
    clear: () => {
      calls.push({ kind: "clear" });
    },
  };
}

type TargetWaiter = {
  readonly target: GuideTargetId;
  readonly event: GuideWaitEvent;
  readonly resolve: () => void;
};

export type FakeGuideTargets = GuideTargetResolver & {
  /** The person used the control the guide pointed at. */
  activate(target: GuideTargetId): void;
  appear(target: GuideTargetId): void;
  disappear(target: GuideTargetId): void;
  /** Signals handed to `observe`; each must be aborted once a run settles. */
  observedSignals(): readonly AbortSignal[];
};

/**
 * `appear` and `disappear` are level-triggered — a target that is already in
 * the asked-for state satisfies the wait immediately, which is how a real DOM
 * adapter behaves. `activate` is an edge, so it only ever settles a wait that
 * was already running.
 */
export function createFakeTargets(
  known: readonly GuideTargetId[],
  mounted: readonly GuideTargetId[],
): FakeGuideTargets {
  const knownTargets = new Set(known);
  const mountedTargets = new Set(mounted);
  const waiters = new Set<TargetWaiter>();
  const signals: AbortSignal[] = [];

  const deliver = (target: GuideTargetId, event: GuideWaitEvent): void => {
    for (const waiter of [...waiters]) {
      if (waiter.target !== target || waiter.event !== event) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  return {
    isKnown: (target: GuideTargetId) => knownTargets.has(target),
    isMounted: (target: GuideTargetId) => mountedTargets.has(target),
    observe: (
      target: GuideTargetId,
      event: GuideWaitEvent,
      signal: AbortSignal,
    ) =>
      new Promise<void>((resolve, reject) => {
        signals.push(signal);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (event === "appear" && mountedTargets.has(target)) {
          resolve();
          return;
        }
        if (event === "disappear" && !mountedTargets.has(target)) {
          resolve();
          return;
        }
        const waiter: TargetWaiter = { target, event, resolve };
        waiters.add(waiter);
        signal.addEventListener(
          "abort",
          () => {
            waiters.delete(waiter);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    activate: (target: GuideTargetId) => {
      deliver(target, "activate");
    },
    appear: (target: GuideTargetId) => {
      mountedTargets.add(target);
      deliver(target, "appear");
    },
    disappear: (target: GuideTargetId) => {
      mountedTargets.delete(target);
      deliver(target, "disappear");
    },
    observedSignals: () => [...signals],
  };
}

type RouteWaiter = {
  readonly route: GuideRouteId;
  readonly resolve: () => void;
};

export type FakeGuideRoutes = GuideRouteController & {
  /** The person navigated themselves — the alternate path to the same place. */
  go(route: GuideRouteId): void;
  /** Routes the runtime navigated to, in order. `go` is not recorded here. */
  navigations(): readonly GuideRouteId[];
  observedSignals(): readonly AbortSignal[];
};

export function createFakeRoutes(
  known: readonly GuideRouteId[],
  current: GuideRouteId,
): FakeGuideRoutes {
  const knownRoutes = new Set(known);
  const waiters = new Set<RouteWaiter>();
  const navigations: GuideRouteId[] = [];
  const signals: AbortSignal[] = [];
  let at = current;

  const arrive = (route: GuideRouteId): void => {
    at = route;
    for (const waiter of [...waiters]) {
      if (waiter.route !== route) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  return {
    current: () => at,
    isKnown: (route: GuideRouteId) => knownRoutes.has(route),
    navigate: (route: GuideRouteId) => {
      navigations.push(route);
      arrive(route);
    },
    observe: (route: GuideRouteId, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signals.push(signal);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (at === route) {
          resolve();
          return;
        }
        const waiter: RouteWaiter = { route, resolve };
        waiters.add(waiter);
        signal.addEventListener(
          "abort",
          () => {
            waiters.delete(waiter);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    go: (route: GuideRouteId) => {
      arrive(route);
    },
    navigations: () => [...navigations],
    observedSignals: () => [...signals],
  };
}

type StateWaiter = {
  readonly predicate: GuidePredicateId;
  readonly expected: boolean;
  readonly resolve: () => void;
};

export type FakeGuideState = GuideStateObserver & {
  /** Sets a coarse fact. A predicate set here is registered by that act. */
  set(predicate: GuidePredicateId, value: boolean): void;
  observedSignals(): readonly AbortSignal[];
};

export function createFakeState(
  values: Iterable<readonly [GuidePredicateId, boolean]>,
): FakeGuideState {
  const facts = new Map<GuidePredicateId, boolean>(values);
  const waiters = new Set<StateWaiter>();
  const signals: AbortSignal[] = [];

  return {
    isKnown: (predicate: GuidePredicateId) => facts.has(predicate),
    read: (predicate: GuidePredicateId) => facts.get(predicate) === true,
    observe: (
      predicate: GuidePredicateId,
      expected: boolean,
      signal: AbortSignal,
    ) =>
      new Promise<void>((resolve, reject) => {
        signals.push(signal);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if ((facts.get(predicate) === true) === expected) {
          resolve();
          return;
        }
        const waiter: StateWaiter = { predicate, expected, resolve };
        waiters.add(waiter);
        signal.addEventListener(
          "abort",
          () => {
            waiters.delete(waiter);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    set: (predicate: GuidePredicateId, value: boolean) => {
      facts.set(predicate, value);
      for (const waiter of [...waiters]) {
        if (waiter.predicate !== predicate || waiter.expected !== value) {
          continue;
        }
        waiters.delete(waiter);
        waiter.resolve();
      }
    },
    observedSignals: () => [...signals],
  };
}
