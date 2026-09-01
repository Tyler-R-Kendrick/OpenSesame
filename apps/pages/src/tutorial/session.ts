/**
 * The composition root for in-product support.
 *
 * Everything the feature is made of is assembled here — the registries that
 * decide what a model may be told and what it may name, whichever agent this
 * browser can actually reach, the deterministic guide runtime, and the
 * renderer that draws on the page. Nothing above this file knows any of them
 * exist: the shell gets a button, the panel gets a controller.
 *
 * **The transcript is memory, and only memory.** Nothing here writes to
 * `localStorage`, `sessionStorage`, IndexedDB, a vault item, a query string or
 * a log line. A support conversation is a record of what somebody could not
 * work out on their own, and keeping that is no part of answering it. Locking
 * the vault drops it outright, along with the model session that saw it.
 *
 * Nothing costly is imported at module scope either. A closed panel costs the
 * boot bundle one button and this state machine; the agent adapters, the guide
 * runtime, Driver.js and the capability registry all arrive on first open.
 */

import type { GuideProgram } from "@opensesame/guide-lang";
import type {
  GuideCancelReason,
  GuideOutcome,
  GuideRuntimeSnapshot,
} from "@opensesame/guide-runtime";
import type {
  SupportAgentAvailability,
  SupportAgentPort,
  SupportComputerStep,
  SupportErrorCode,
  SupportSession,
} from "@opensesame/support-agent";
import {
  type ReactElement,
  type ReactNode,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { vaultStore } from "../lib/vault/store.js";
import { webmcpSupportSeam } from "../webmcp/tools.js";
import { HELP_TOPICS, guideGoal, guideGoalIds } from "./registry/goals.js";
import {
  GUIDE_ROUTES,
  type GuideRouteId,
  guideRouteForPath,
} from "./registry/routes.js";
import { guidePredicateIds } from "./registry/state.js";
import {
  clearMountedGuideTargets,
  guideTargetIds,
} from "./registry/targets.js";
import {
  GUIDE_ERROR_TEXT,
  GUIDE_REFUSED_TEXT,
  SUPPORT_ERROR_TEXT,
  UNEXPECTED_TEXT,
} from "./ui/messages.js";

/**
 * Who wrote the walkthrough. It selects the vocabulary it is checked against,
 * never whether it is checked.
 */
export type GuideOrigin = "model" | "authored";

/** Where an answer comes from. Only `remote` leaves the device. */
export type SupportTransport = "none" | "on-device" | "remote";

export type SupportEntryKind = "question" | "answer" | "note";

/**
 * One line of the conversation. Text only — the panel renders it as React text
 * nodes, so there is no markup path from a model into the document.
 */
export type SupportEntry = {
  readonly id: string;
  readonly kind: SupportEntryKind;
  readonly text: string;
  readonly suggestions: readonly string[];
  readonly thoughts: string | null;
  readonly computer: readonly SupportComputerStep[];
};

export type SupportView = {
  readonly open: boolean;
  /** True once the engine has loaded. The written help works before it does. */
  readonly ready: boolean;
  readonly thinking: boolean;
  /** Null until something has reported. */
  readonly availability: SupportAgentAvailability | null;
  readonly transport: SupportTransport;
  /** The remote-transport warning, present only when answers leave the device. */
  readonly warning: string | null;
  readonly transcript: readonly SupportEntry[];
  readonly error: string | null;
  readonly guide: GuideRuntimeSnapshot | null;
  readonly route: GuideRouteId;
};

export type SupportAcquireResult =
  | { readonly kind: "acquired" }
  | { readonly kind: "failed"; readonly code: SupportErrorCode };

/**
 * What the panel needs from whatever is answering, in this app's own terms.
 * The packages are adapted onto it in exactly one place — `loadBrowserEngine`
 * below — so a new transport or a new renderer never reaches the UI.
 */
export interface SupportEngine {
  readonly transport: SupportTransport;
  readonly warning: string | null;
  /** Owns the model conversation, and drops it on `destroy`. */
  readonly session: SupportSession;
  /**
   * Compiles model-authored GuideLang against the vocabulary of the page as it
   * is right now — the model may only name what it was actually shown.
   */
  compile(source: string): GuideProgram | null;
  /**
   * Compiles a checked-in walkthrough against the whole registry.
   *
   * Same parser, same validator, same budgets: the difference is the vocabulary
   * these two are handed, and it differs because their provenance does. A
   * walkthrough that says "go to Connections, then point at the picker" names a
   * target that is by definition not on screen yet, and scoping it to the
   * current route made five of the seven authored goals refuse to start from
   * the screen that offered them. `catalog.test.ts` already compiles every one
   * against this same full vocabulary, so nothing reaches here unreviewed.
   */
  compileAuthored(source: string): GuideProgram | null;
  runGuide(program: GuideProgram): Promise<GuideOutcome>;
  pauseGuide(): void;
  cancelGuide(reason: GuideCancelReason): void;
  subscribeGuide(
    listener: (snapshot: GuideRuntimeSnapshot) => void,
  ): () => void;
  /** Acquires an on-device model. Only ever called from a user gesture. */
  acquire(
    onProgress: (fraction: number) => void,
  ): Promise<SupportAcquireResult>;
  /** Cancels the runtime, clears every overlay, drops the model session. */
  destroy(): void;
}

/**
 * What the engine needs from the running app: in-app navigation, where we are,
 * and a way to be told when that changed. The router is a React concern, so it
 * is handed down rather than reached for.
 */
export type SupportHost = {
  readonly navigate: (route: GuideRouteId) => void;
  readonly currentRoute: () => GuideRouteId;
  readonly observeRoute: (
    route: GuideRouteId,
    signal: AbortSignal,
  ) => Promise<void>;
};

export interface SupportController {
  subscribe(listener: () => void): () => void;
  view(): SupportView;
  open(): void;
  close(): void;
  setRoute(route: GuideRouteId): void;
  setNavigator(navigate: (route: GuideRouteId) => void): void;
  ask(question: string): Promise<void>;
  /** Stops the question in flight. The panel stays open and keeps its history. */
  cancel(): void;
  clear(): void;
  acquireModel(): Promise<void>;
  /** Puts an authored question and its checked-in answer into the transcript. */
  answerFromAuthoredHelp(question: string, answer: string): void;
  startGuide(source: string, origin?: GuideOrigin): Promise<void>;
  pauseGuide(): void;
  stopGuide(): void;
  /**
   * The vault locked. Drops the transcript, the model session and every
   * overlay a walkthrough drew, and resets the panel.
   */
  lock(): void;
  destroy(): void;
}

export type SupportSessionDependencies = {
  loadEngine: (host: SupportHost) => Promise<SupportEngine>;
  onLock: (handler: () => void) => () => void;
  clearTargets: () => void;
};

function emptyView(route: GuideRouteId): SupportView {
  return {
    open: false,
    ready: false,
    thinking: false,
    availability: null,
    transport: "none",
    warning: null,
    transcript: [],
    error: null,
    guide: null,
    route,
  };
}

export function createSupportController(
  dependencies: SupportSessionDependencies,
): SupportController {
  let state = emptyView("/vault");
  const listeners = new Set<() => void>();
  const routeListeners = new Set<() => void>();

  let engine: SupportEngine | null = null;
  let loading: Promise<SupportEngine | null> | null = null;
  let stopGuideFeed: (() => void) | null = null;
  let navigator: ((route: GuideRouteId) => void) | null = null;
  let entries = 0;
  let cancelled = false;
  /** Bumped by teardown, so a load in flight cannot install a stale engine. */
  let generation = 0;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(patch: Partial<SupportView>): void {
    state = { ...state, ...patch };
    emit();
  }

  function push(
    kind: SupportEntryKind,
    text: string,
    suggestions: readonly string[],
    traces?: {
      readonly thoughts?: string | null;
      readonly computer?: readonly SupportComputerStep[];
    },
  ): void {
    entries += 1;
    set({
      transcript: [
        ...state.transcript,
        {
          id: `e${entries}`,
          kind,
          text,
          suggestions,
          thoughts: traces?.thoughts ?? null,
          computer: traces?.computer ?? [],
        },
      ],
    });
  }

  const host: SupportHost = {
    navigate: (route) => navigator?.(route),
    currentRoute: () => state.route,
    observeRoute: (route, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        if (state.route === route) {
          queueMicrotask(resolve);
          return;
        }
        const stop = () => {
          routeListeners.delete(check);
          signal.removeEventListener("abort", onAbort);
        };
        const check = () => {
          if (state.route !== route) return;
          stop();
          resolve();
        };
        const onAbort = () => {
          stop();
          reject(new DOMException("aborted", "AbortError"));
        };
        routeListeners.add(check);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  };

  function ensureEngine(): Promise<SupportEngine | null> {
    if (engine) return Promise.resolve(engine);
    if (!loading) {
      const era = generation;
      loading = dependencies
        .loadEngine(host)
        .then((loaded) => {
          if (era !== generation) {
            loaded.destroy();
            return null;
          }
          engine = loaded;
          stopGuideFeed = loaded.subscribeGuide((snapshot) =>
            set({ guide: snapshot }),
          );
          set({
            ready: true,
            transport: loaded.transport,
            warning: loaded.warning,
          });
          return loaded;
        })
        .catch(() => {
          // A chunk that failed to load (an offline first open, say) is worth
          // retrying: dropping the memo is what lets the next ask try again.
          if (era === generation) {
            loading = null;
            set({ ready: true, error: UNEXPECTED_TEXT });
          }
          return null;
        });
    }
    return loading;
  }

  async function refreshAvailability(): Promise<void> {
    const loaded = await ensureEngine();
    if (!loaded || engine !== loaded) return;
    const availability = await loaded.session.availability();
    if (engine !== loaded) return;
    set({ availability });
  }

  async function runProgram(program: GuideProgram): Promise<void> {
    const loaded = engine;
    if (!loaded) return;
    // A walkthrough points at controls on the page, and this app's sheet
    // covers a third of them — including the statusline the shell targets sit
    // in. So the panel steps aside while one runs; the transcript is still
    // there, and the statusline button says a walkthrough is live.
    set({ open: false });
    const outcome = await loaded.runGuide(program);
    if (engine !== loaded) return;
    if (outcome.kind === "failed") {
      set({ error: GUIDE_ERROR_TEXT[outcome.error.code] });
      return;
    }
    if (outcome.kind === "completed") {
      const closing = state.guide?.message;
      if (closing) push("note", closing, []);
    }
  }

  async function startGuide(
    source: string,
    origin: GuideOrigin = "model",
  ): Promise<void> {
    const loaded = await ensureEngine();
    if (!loaded) {
      set({ error: SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE });
      return;
    }
    const program =
      origin === "authored"
        ? loaded.compileAuthored(source)
        : loaded.compile(source);
    if (!program) {
      set({ error: GUIDE_ERROR_TEXT.GUIDE_VALIDATION_ERROR });
      return;
    }
    set({ error: null });
    await runProgram(program);
  }

  function teardown(): void {
    generation += 1;
    stopGuideFeed?.();
    stopGuideFeed = null;
    if (engine) {
      engine.cancelGuide("lock");
      engine.destroy();
    }
    engine = null;
    loading = null;
    dependencies.clearTargets();
    // Everything the person said, everything that answered, and every overlay
    // it drew goes with the keys.
    state = emptyView(state.route);
    emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view() {
      return state;
    },
    open() {
      if (state.open) return;
      set({ open: true });
      void refreshAvailability();
    },
    close() {
      set({ open: false });
    },
    setRoute(route) {
      if (state.route === route) return;
      set({ route });
      for (const listener of [...routeListeners]) listener();
    },
    setNavigator(next) {
      navigator = next;
    },
    async ask(question) {
      const text = question.trim();
      if (text.length === 0 || state.thinking) return;
      push("question", text, []);
      set({ error: null });
      const loaded = await ensureEngine();
      if (!loaded) {
        set({ error: SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE });
        return;
      }
      cancelled = false;
      set({ thinking: true });
      await loaded.session.ask(text);
      if (engine !== loaded) return;
      set({ thinking: false });
      if (cancelled) {
        cancelled = false;
        push("note", SUPPORT_ERROR_TEXT.AGENT_ABORTED, []);
        return;
      }
      const snapshot = loaded.session.snapshot();
      if (snapshot.status === "error") {
        set({
          error: SUPPORT_ERROR_TEXT[snapshot.error ?? "AGENT_PROTOCOL_ERROR"],
        });
        void refreshAvailability();
        return;
      }
      const last = snapshot.messages.at(-1);
      if (last && last.role === "assistant") {
        push("answer", last.text, snapshot.suggestedQuestions, {
          thoughts: snapshot.thoughts,
          computer: snapshot.computer,
        });
      }
      // A walkthrough the compiler rejected is reported as a walkthrough that
      // did not run — never as the codes it failed with, and never as the text.
      if (snapshot.guideError) push("note", GUIDE_REFUSED_TEXT, []);
      if (snapshot.program) await runProgram(snapshot.program);
    },
    cancel() {
      if (!state.thinking) return;
      cancelled = true;
      engine?.session.cancel();
    },
    clear() {
      engine?.session.clear();
      set({ transcript: [], error: null });
    },
    async acquireModel() {
      const loaded = await ensureEngine();
      if (!loaded) return;
      set({ availability: { kind: "downloading", progress: 0 }, error: null });
      const result = await loaded.acquire((progress) => {
        if (engine !== loaded) return;
        set({ availability: { kind: "downloading", progress } });
      });
      if (engine !== loaded) return;
      if (result.kind === "failed") {
        set({ error: SUPPORT_ERROR_TEXT[result.code] });
      }
      await refreshAvailability();
    },
    answerFromAuthoredHelp(question, answer) {
      push("question", question, []);
      push("answer", answer, []);
    },
    startGuide(source, origin) {
      return startGuide(source, origin);
    },
    pauseGuide() {
      engine?.pauseGuide();
    },
    stopGuide() {
      engine?.cancelGuide("user");
    },
    lock() {
      teardown();
    },
    destroy() {
      teardown();
      listeners.clear();
      routeListeners.clear();
    },
  };
}

export type SupportAgentChoice = {
  readonly port: SupportAgentPort;
  readonly transport: SupportTransport;
};

/**
 * Which agent answers — and therefore whether a question leaves the device.
 *
 * On-device wins whenever it can answer at all, including while its model is
 * still downloading. A configured endpoint wins in exactly one case: the local
 * model reports that it cannot answer. With no endpoint either, the local port
 * is kept anyway, because its own reason ("not downloaded", "unsupported") is
 * the honest thing to put in front of somebody — and `absent` is the last
 * resort, so the panel still opens on a browser that has neither.
 */
export function chooseSupportAgent(
  local: SupportAgentPort | null,
  localState: SupportAgentAvailability | null,
  openRemote: () => SupportAgentPort | null,
  absent: SupportAgentPort,
): SupportAgentChoice {
  // `downloadable` counts as the device being able to answer, deliberately.
  // The panel says so plainly and offers the download as a click; preferring a
  // configured endpoint here would send somebody's questions off the device
  // because their own browser had not fetched a model they were never asked
  // about. On-device is the privacy-preserving default, and a default that
  // quietly yields to a remote one the first time it is inconvenient is not a
  // default.
  const answers = localState !== null && localState.kind !== "unavailable";
  if (local !== null && answers) return { port: local, transport: "on-device" };
  const remote = openRemote();
  if (remote !== null) {
    // Nothing may hold a second provider session open behind the one in use.
    local?.destroy();
    return { port: remote, transport: "remote" };
  }
  if (local !== null) return { port: local, transport: "on-device" };
  return { port: absent, transport: "none" };
}

/* ——— The browser wiring ————————————————————————————————————————
   The one place this app names anything in `@opensesame/support-agent`,
   `@opensesame/guide-runtime`, the agent transports or the renderer. Every
   import is dynamic, so none of it is in the boot bundle. */

export async function loadBrowserEngine(
  host: SupportHost,
): Promise<SupportEngine> {
  const [
    agent,
    guideLang,
    guideRuntime,
    context,
    targets,
    routes,
    predicateState,
    rendering,
    promptApi,
    agUi,
    predicates,
    connectivity,
  ] = await Promise.all([
    import("@opensesame/support-agent"),
    import("@opensesame/guide-lang"),
    import("@opensesame/guide-runtime"),
    import("./registry/context.js"),
    import("./registry/targets.js"),
    import("./registry/routes.js"),
    import("./registry/state.js"),
    import("./rendering/index.js"),
    import("./agents/prompt-api/index.js"),
    import("./agents/ag-ui/index.js"),
    import("./registry/predicates.js"),
    import("../lib/connectivity-monitor.js"),
  ]);

  predicates.registerGuidePredicates();

  /** A local model that cannot report is treated as one that cannot answer. */
  async function localAvailability(
    port: SupportAgentPort,
  ): Promise<SupportAgentAvailability> {
    try {
      return await port.availability();
    } catch {
      return { kind: "unavailable", reason: "platform_unsupported" };
    }
  }

  /** Stands in when this browser has neither, so the panel still opens. */
  const absent = {
    availability: (): Promise<SupportAgentAvailability> =>
      Promise.resolve({ kind: "unavailable", reason: "no_local_model" }),
    run: () =>
      Promise.reject(
        new agent.SupportError(
          "AGENT_UNAVAILABLE",
          "no support agent is available in this browser",
        ),
      ),
    destroy: () => {},
  };
  const local = promptApi.createPromptApiAgent();
  const { port, transport } = chooseSupportAgent(
    local,
    local === null ? null : await localAvailability(local),
    () => agUi.createAgUiAgent(),
    absent,
  );

  function readContext() {
    return context.buildSupportPageContext({
      pageId: "pages",
      route: host.currentRoute(),
      hostReachable:
        connectivity.connectivitySnapshot().host.health === "reachable",
      identityReachable:
        connectivity.connectivitySnapshot().identity.health === "reachable",
    });
  }

  /**
   * Read through on every compile rather than snapshotted at session creation:
   * the page the person is looking at moves, and the vocabulary a program is
   * checked against has to be the one they were shown, not the one they were
   * shown when the panel opened.
   */
  /**
   * The whole registry, for checked-in walkthroughs. A cross-route guide names
   * a control on the screen it is about to navigate to, which the route-scoped
   * vocabulary above cannot contain by construction.
   */
  const authoredVocabulary = {
    goals: guideGoalIds(),
    targets: guideTargetIds(),
    routes: GUIDE_ROUTES.map((route) => route.id),
    predicates: guidePredicateIds(),
  };

  const vocabulary = {
    get goals() {
      return readContext().goals.map((goal) => goal.id);
    },
    get targets() {
      return readContext().targets.map((target) => target.id);
    },
    get routes() {
      return readContext().routes.map((route) => route.id);
    },
    get predicates() {
      return readContext().state.map((fact) => fact.id);
    },
  };

  const session = agent.createSupportSession({ port, vocabulary, readContext });

  const renderer = await rendering.loadDriverRenderer({
    resolveElement: targets.resolveGuideTargetElement,
    reducedMotion: () =>
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      false,
  });

  const runtime = guideRuntime.createGuideRuntime({
    renderer,
    targets: {
      isMounted: targets.isMountedGuideTarget,
      isKnown: targets.isKnownGuideTarget,
      observe: targets.observeGuideTarget,
    },
    routes: {
      current: host.currentRoute,
      isKnown: routes.isKnownGuideRoute,
      navigate: host.navigate,
      observe: host.observeRoute,
    },
    state: {
      isKnown: predicateState.isKnownGuidePredicate,
      read: predicateState.readGuidePredicate,
      observe: predicateState.observeGuidePredicate,
    },
    clock: guideRuntime.systemGuideClock(),
  });

  return {
    transport,
    warning: transport === "remote" ? agent.redactionWarning() : null,
    session,
    compile(source) {
      const result = guideLang.compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    compileAuthored(source) {
      const result = guideLang.compileGuide(source, authoredVocabulary);
      return result.ok ? result.program : null;
    },
    runGuide(program) {
      return runtime.start(program);
    },
    pauseGuide() {
      runtime.pause();
    },
    cancelGuide(reason) {
      runtime.cancel(reason);
    },
    subscribeGuide(listener) {
      return runtime.subscribe({ onSnapshot: listener });
    },
    async acquire(onProgress) {
      try {
        await promptApi.acquirePromptApiModel(onProgress);
        return { kind: "acquired" };
      } catch (cause) {
        if (cause instanceof agent.SupportError) {
          return { kind: "failed", code: cause.code };
        }
        return { kind: "failed", code: "AGENT_UNAVAILABLE" };
      }
    },
    destroy() {
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
    },
  };
}

/** Swapped wholesale by tests; the browser wiring is the default. */
export const supportSessionSeams: SupportSessionDependencies = {
  loadEngine: loadBrowserEngine,
  onLock: (handler) => vaultStore.onLock(handler),
  clearTargets: clearMountedGuideTargets,
};

const SupportContext = createContext<SupportController | null>(null);

const SupportRouteOverrideContext = createContext<
  (route: GuideRouteId | null) => void
>(() => {});

/**
 * Screens that are not a URL — unlock, setup, the broker popup — declare
 * themselves so page context names the ceremony the person is actually in,
 * not the path the router still holds.
 */
export function useSupportRoute(route: GuideRouteId): void {
  const setOverride = useContext(SupportRouteOverrideContext);
  useEffect(() => {
    setOverride(route);
    return () => setOverride(null);
  }, [route, setOverride]);
}

/**
 * Written with `createElement` rather than JSX so the composition root stays a
 * `.ts` file: it wires the feature together, it does not draw anything.
 */
export function SupportProvider({
  children,
}: { children?: ReactNode }): ReactElement {
  const [controller] = useState(() =>
    createSupportController(supportSessionSeams),
  );
  const location = useLocation();
  const navigate = useNavigate();
  const [override, setOverride] = useState<GuideRouteId | null>(null);
  const setRouteOverride = useCallback((route: GuideRouteId | null) => {
    setOverride(route);
  }, []);

  useEffect(() => () => controller.destroy(), [controller]);

  // Subscribed here rather than at construction: the controller then has no
  // side effect of its own, so React creating and discarding one (as it does
  // in StrictMode) cannot leave a handler behind holding this session's keys.
  useEffect(
    () => supportSessionSeams.onLock(() => controller.lock()),
    [controller],
  );

  useEffect(() => {
    controller.setRoute(override ?? guideRouteForPath(location.pathname));
  }, [controller, location.pathname, override]);

  useEffect(() => {
    controller.setNavigator((route) => navigate(route));
  }, [controller, navigate]);

  // WebMCP's two guidance tools open this panel and start authored
  // walkthroughs; both are given ids the registry declares, and neither can
  // reach the model, the transcript or an authority mutation. Binding here
  // rather than in the tool keeps the no-op default honest in a build that
  // ships no support UI.
  useEffect(() => {
    const previous = { ...webmcpSupportSeam };
    Object.assign(webmcpSupportSeam, {
      openSupport: (topic: string | null) => {
        controller.open();
        const authored = HELP_TOPICS.find((entry) => entry.id === topic);
        if (authored) {
          controller.answerFromAuthoredHelp(authored.title, authored.answer);
        }
      },
      startGuide: (goal: string) => {
        const named = guideGoal(goal);
        if (named) void controller.startGuide(named.guide, "authored");
      },
    });
    return () => {
      Object.assign(webmcpSupportSeam, previous);
    };
  }, [controller]);

  return createElement(
    SupportRouteOverrideContext.Provider,
    { value: setRouteOverride },
    createElement(SupportContext.Provider, { value: controller }, children),
  );
}

export type SupportAccess = {
  readonly view: SupportView;
  readonly support: SupportController;
};

export function useSupport(): SupportAccess {
  const controller = useContext(SupportContext);
  if (!controller) throw new Error("support_provider_missing");
  const view = useSyncExternalStore(controller.subscribe, controller.view);
  return { view, support: controller };
}
