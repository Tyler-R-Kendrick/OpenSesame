import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { rankHelpTopics } from "@opensesame/app-core/tutorial/registry/goals-search.js";
import {
  HELP_TOPICS,
  type HelpTopic,
  guideGoal,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import { clearMountedGuideTargets } from "@opensesame/app-core/tutorial/registry/targets.js";
import { webmcpSupportSeam } from "@opensesame/app-core/webmcp/tool-shared.js";
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
import type { GuideGoalId, GuideProgram } from "@opensesame/guide-lang";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import type {
  SupportAgentAvailability,
  SupportComputerStep,
  SupportSessionSnapshot,
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
import { useVault } from "../lib/vault/hooks.js";
import { gateSupportAsk } from "./ask-guard.js";
import {
  type GuideOrigin,
  type SupportEngine,
  type SupportHost,
  type SupportTransport,
  loadBrowserEngine,
} from "./engine.js";
import { SupportContext } from "./support-context.js";
import {
  GUIDE_ERROR_TEXT,
  GUIDE_REFUSED_TEXT,
  NOTHING_WRITTEN_TEXT,
  SUPPORT_ERROR_TEXT,
  UNEXPECTED_TEXT,
  UNVERIFIED_TEXT,
  citedHelpText,
  writtenHelpSaysText,
} from "./ui/messages.js";
import { useSupportRouteSync } from "./use-support-route.js";
export type {
  GuideOrigin,
  SupportAcquireResult,
  SupportEngine,
  SupportHost,
  SupportTransport,
} from "./engine.js";
export { loadBrowserEngine } from "./engine.js";
export type SupportEntryKind = "question" | "answer" | "note";
/** An authored walkthrough offered beside a line, by registry id only. */
export type SupportWalkthrough = {
  readonly goal: GuideGoalId;
  readonly title: string;
};
/** What an answer or note carries besides its text; every member optional. */
export type SupportEntryExtras = {
  readonly thoughts?: string | null;
  readonly computer?: readonly SupportComputerStep[];
  readonly walkthroughs?: readonly SupportWalkthrough[];
};
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
  /** Checked-in walkthroughs that go with the written help this line rests on. */
  readonly walkthroughs: readonly SupportWalkthrough[];
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
  readonly guide: GuideRuntimeSnapshot | null;
  readonly route: GuideRouteId;
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
  /** Tour controls: each is a no-op when no tour is on a step. */
  nextStep(): void;
  backStep(): void;
  replayGuide(): void;
  /** Leaves the tour; Escape and the close key are this. */
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

  /**
   * A failure is a notice in the tray, never a paragraph inside the sheet.
   *
   * The sheet is where a person is trying to get an answer; an error box in it
   * is explainer copy about the panel rather than the row, field or receipt
   * that failed (`docs/design/controls.md`). The tray already carries every
   * other page condition, so a walkthrough that stopped or a question nothing
   * could answer lands there beside them — and the written help below still
   * works, which is the answer to "what now".
   */
  function notifyFailure(body: string): void {
    setStatusNotice({
      id: "support.failure",
      tone: "warn",
      title: "Support",
      body,
    });
  }

  function push(
    kind: SupportEntryKind,
    text: string,
    suggestions: readonly string[],
    traces?: SupportEntryExtras,
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
          walkthroughs: traces?.walkthroughs ?? [],
        },
      ],
    });
  }

  /** The authored walkthroughs behind a set of help topics, deduplicated. */
  function walkthroughsFor(
    topics: readonly { readonly goal: string | null }[],
  ): readonly SupportWalkthrough[] {
    const out: SupportWalkthrough[] = [];
    for (const topic of topics) {
      if (topic.goal === null) continue;
      const named = guideGoal(topic.goal);
      if (!named || out.some((held) => held.goal === named.id)) continue;
      out.push({ goal: named.id, title: named.title });
    }
    return out;
  }

  /**
   * What the person is told about where an answer came from — the one place
   * the written help overrides a model rather than merely informing it.
   *
   * A reply that cites written help is labelled with what it cited, and the
   * walkthroughs behind those entries are offered. A reply that cites nothing
   * while the written help confidently covers the question gets the written
   * answer put beside it, because a procedure the help graph does not contain
   * is exactly the kind of answer ADR 0088 says the graph corrects. A reply
   * that cites nothing and matches nothing is marked unverified rather than
   * hidden: the person asked, and an honest label beats silence.
   */
  function noteGrounding(
    question: string,
    grounding: SupportSessionSnapshot["grounding"],
  ): void {
    if (grounding?.kind === "cited") {
      push(
        "note",
        citedHelpText(grounding.help.map((entry) => entry.title)),
        [],
        { walkthroughs: walkthroughsFor(grounding.help) },
      );
      return;
    }
    const best: HelpTopic | null =
      rankHelpTopics(question, state.route).find((entry) => entry.strong)
        ?.topic ?? null;
    if (best !== null) {
      push("note", writtenHelpSaysText(best.title, best.answer), [], {
        walkthroughs: walkthroughsFor([best]),
      });
      return;
    }
    push(
      "note",
      grounding?.kind === "none" ? NOTHING_WRITTEN_TEXT : UNVERIFIED_TEXT,
      [],
    );
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
            set({ ready: true });
            notifyFailure(UNEXPECTED_TEXT);
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

  async function runProgram(
    program: GuideProgram,
    origin: GuideOrigin,
  ): Promise<void> {
    const loaded = engine;
    if (!loaded) return;
    // A tour points at controls on the page, and this app's sheet covers a
    // third of them — including the statusline the shell targets sit in. So
    // the panel steps aside while one runs; the transcript is still there,
    // and the tour's own card (`CoachHud`) carries the steps.
    set({ open: false });
    const outcome = await loaded.runGuide(program, origin);
    if (engine !== loaded) return;
    if (outcome.kind === "failed") {
      notifyFailure(GUIDE_ERROR_TEXT[outcome.error.code]);
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
      notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
      return;
    }
    const program =
      origin === "authored"
        ? loaded.compileAuthored(source)
        : loaded.compile(source);
    if (!program) {
      notifyFailure(GUIDE_ERROR_TEXT.GUIDE_VALIDATION_ERROR);
      return;
    }
    await runProgram(program, origin);
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
      const gate = gateSupportAsk(question, state.thinking);
      if (gate.kind === "skip") return;
      const { text } = gate;
      push("question", text, []);
      const loaded = await ensureEngine();
      if (!loaded) {
        const authored = rankHelpTopics(text, state.route).find(
          (e) => e.strong,
        )?.topic;
        if (authored) {
          push("answer", authored.answer, [], {
            walkthroughs: walkthroughsFor([authored]),
          });
          return;
        }
        notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
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
        const authored = rankHelpTopics(text, state.route).find(
          (entry) => entry.strong,
        )?.topic;
        if (authored && snapshot.error === "AGENT_UNAVAILABLE") {
          push("answer", authored.answer, [], {
            walkthroughs: walkthroughsFor([authored]),
          });
          void refreshAvailability();
          return;
        }
        notifyFailure(
          SUPPORT_ERROR_TEXT[snapshot.error ?? "AGENT_PROTOCOL_ERROR"],
        );
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
      if (snapshot.guideError) notifyFailure(GUIDE_REFUSED_TEXT);
      if (last && last.role === "assistant") {
        noteGrounding(text, snapshot.grounding);
      }
      if (snapshot.program) await runProgram(snapshot.program, "model");
    },
    cancel() {
      if (!state.thinking) return;
      cancelled = true;
      engine?.session.cancel();
    },
    clear() {
      engine?.session.clear();
      set({ transcript: [] });
    },
    async acquireModel() {
      const loaded = await ensureEngine();
      if (!loaded) return;
      set({ availability: { kind: "downloading", progress: 0 } });
      const result = await loaded.acquire((progress) => {
        if (engine !== loaded) return;
        set({ availability: { kind: "downloading", progress } });
      });
      if (engine !== loaded) return;
      if (result.kind === "failed") {
        notifyFailure(SUPPORT_ERROR_TEXT[result.code]);
      }
      await refreshAvailability();
    },
    answerFromAuthoredHelp(question, answer) {
      push("question", question, []);
      const topic = HELP_TOPICS.find((entry) => entry.answer === answer);
      push("answer", answer, [], {
        walkthroughs: topic ? walkthroughsFor([topic]) : [],
      });
    },
    startGuide(source, origin) {
      return startGuide(source, origin);
    },
    pauseGuide() {
      engine?.pauseGuide();
    },
    nextStep() {
      engine?.nextStep();
    },
    backStep() {
      engine?.backStep();
    },
    replayGuide() {
      engine?.restartGuide();
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

/** Swapped wholesale by tests; the browser wiring is the default. */
export const supportSessionSeams: SupportSessionDependencies = {
  loadEngine: loadBrowserEngine,
  onLock: (handler) => vaultStore.onLock(handler),
  clearTargets: clearMountedGuideTargets,
};

export const SupportRouteOverrideContext = createContext<
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

  useSupportRouteSync(controller, override);

  // WebMCP guidance tools bind only while unlocked (no help on title/unlock).
  const { status: vaultStatus } = useVault();
  useEffect(() => {
    if (vaultStatus !== "unlocked") return;
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
  }, [controller, vaultStatus]);

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
