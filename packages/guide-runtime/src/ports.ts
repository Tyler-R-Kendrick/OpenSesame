/**
 * Ports the deterministic guide runtime drives.
 *
 * Nothing here touches the DOM, a router, or a renderer. The runtime is a
 * state machine over semantic identifiers; the browser adapters in
 * `apps/pages/src/tutorial/` are the only code allowed to turn a
 * `GuideTargetId` into an element, and they do it from a registry the
 * application authored — never from a string the model wrote.
 */

import type {
  GuideGoalId,
  GuidePredicateId,
  GuideProgram,
  GuideRouteId,
  GuideSide,
  GuideTargetId,
  GuideWaitEvent,
} from "@opensesame/guide-lang";

export type GuideFocusRequest = {
  readonly target: GuideTargetId;
  readonly message: string;
  readonly side: GuideSide | null;
};

export type GuideHintRequest = GuideFocusRequest;
export type GuideAnnotateRequest = GuideFocusRequest;

export type GuideScrollRequest = {
  readonly target: GuideTargetId;
};

/**
 * The rendering surface. Driver.js sits behind this in the browser; the tests
 * drive a recording fake. Every `message` reaching a renderer is untrusted
 * model text and must be written to the document as *text*, never as markup.
 */
export interface GuideRenderer {
  focus(request: GuideFocusRequest): Promise<void>;
  hint(request: GuideHintRequest): Promise<void>;
  annotate(request: GuideAnnotateRequest): Promise<void>;
  scroll(request: GuideScrollRequest): Promise<void>;
  /** Tear down every overlay, popover and hint this renderer owns. */
  clear(): void;
}

export interface GuideTargetResolver {
  /** Whether the registry currently has a mounted element for this target. */
  isMounted(target: GuideTargetId): boolean;
  /** Whether the target is declared at all. Unknown targets fail closed. */
  isKnown(target: GuideTargetId): boolean;
  /**
   * Settles when the target reaches `event`. Rejects with an `AbortError`
   * when `signal` aborts. Never resolves on its own timer — the runtime owns
   * every deadline.
   */
  observe(
    target: GuideTargetId,
    event: GuideWaitEvent,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GuideRouteController {
  current(): GuideRouteId;
  isKnown(route: GuideRouteId): boolean;
  /** Non-mutating in-app navigation only. Never submits or leaves the origin. */
  navigate(route: GuideRouteId): void;
  /** Settles when the app is at `route`; rejects on abort. */
  observe(route: GuideRouteId, signal: AbortSignal): Promise<void>;
}

export interface GuideStateObserver {
  isKnown(predicate: GuidePredicateId): boolean;
  read(predicate: GuidePredicateId): boolean;
  /** Settles when `predicate` equals `expected`; rejects on abort. */
  observe(
    predicate: GuidePredicateId,
    expected: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Injectable deadline source. Tests supply a deterministic clock so no guide
 * test ever sleeps on a real timer.
 */
export interface GuideClock {
  /** Resolves after `ms`, or never if `signal` aborts first. */
  after(ms: number, signal: AbortSignal): Promise<void>;
}

export type GuideRuntimeErrorCode =
  | "TARGET_NOT_MOUNTED"
  | "UNKNOWN_TARGET"
  | "UNKNOWN_ROUTE"
  | "UNKNOWN_PREDICATE"
  | "GUIDE_VALIDATION_ERROR"
  | "GUIDE_TIMEOUT"
  | "GUIDE_SUPERSEDED"
  | "VAULT_LOCKED";

export type GuideRuntimeError = {
  readonly code: GuideRuntimeErrorCode;
  /** Semantic detail — an identifier or limit name. Never model prose. */
  readonly detail: string;
};

export type GuideCancelReason = "user" | "lock" | "navigation" | "superseded";

/**
 * What the runtime tells the support layer when a trajectory settles. The
 * support agent replans from this, which is why it carries semantic facts
 * rather than a rendering log.
 */
export type GuideOutcome =
  | { readonly kind: "completed"; readonly goal: GuideGoalId }
  | {
      readonly kind: "observed";
      readonly goal: GuideGoalId;
      readonly route: GuideRouteId;
      readonly note: string;
    }
  | { readonly kind: "paused"; readonly goal: GuideGoalId }
  | {
      readonly kind: "cancelled";
      readonly goal: GuideGoalId;
      readonly reason: GuideCancelReason;
    }
  | {
      readonly kind: "failed";
      readonly goal: GuideGoalId;
      readonly error: GuideRuntimeError;
    };

export type GuideRuntimeStatus =
  | "idle"
  | "running"
  | "waiting"
  | "paused"
  | "done"
  | "failed";

export type GuideRuntimeSnapshot = {
  readonly status: GuideRuntimeStatus;
  readonly goal: GuideGoalId | null;
  /** Zero-based index of the instruction in flight. */
  readonly index: number;
  readonly total: number;
  /** Monotonic run identifier; stale async work compares against it. */
  readonly runId: number;
  /** The last `say`/`success` line, for the support transcript. */
  readonly message: string | null;
  readonly error: GuideRuntimeError | null;
};

export interface GuideRuntimeObserver {
  onSnapshot(snapshot: GuideRuntimeSnapshot): void;
}

export type GuideRuntimePorts = {
  readonly renderer: GuideRenderer;
  readonly targets: GuideTargetResolver;
  readonly routes: GuideRouteController;
  readonly state: GuideStateObserver;
  readonly clock: GuideClock;
};

export interface GuideRuntime {
  /**
   * Runs one trajectory to its next observation boundary. Starting a run
   * supersedes any run already in flight — `maxConcurrentGuides` is 1.
   */
  start(program: GuideProgram): Promise<GuideOutcome>;
  pause(): void;
  cancel(reason: GuideCancelReason): void;
  snapshot(): GuideRuntimeSnapshot;
  subscribe(observer: GuideRuntimeObserver): () => void;
}
