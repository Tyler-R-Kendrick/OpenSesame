/**
 * The browser engine behind the support controller: the agent this browser can
 * reach, the GuideLang compiler, and the deterministic guide runtime, all
 * assembled on first open.
 *
 * Split from `session.ts` so the controller is a state machine and this is the
 * wiring. Everything here is reached through `import()` — a vault that never
 * asks for help never fetches the parser, the runtime or an agent.
 */
import type { PageContextInput } from "@opensesame/app-core/tutorial/registry/context.js";
import { guideGoalIds } from "@opensesame/app-core/tutorial/registry/goals.js";
import {
  GUIDE_ROUTES,
  type GuideRouteId,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import { guidePredicateIds } from "@opensesame/app-core/tutorial/registry/state.js";
import { guideTargetIds } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideProgram } from "@opensesame/guide-lang";
import type {
  GuideCancelReason,
  GuideOutcome,
  GuideRuntimeSnapshot,
} from "@opensesame/guide-runtime";
import type {
  SupportAgentAvailability,
  SupportAgentPort,
  SupportErrorCode,
  SupportSession,
} from "@opensesame/support-agent";
import { ABSENT_AGENT_LOADERS, supportAgentLoaders } from "./agent-seams.js";
import { chooseSupportAgent } from "./choose-agent.js";
import { tourRunner } from "./tour-runner.js";

/** Who wrote the walkthrough. It selects the vocabulary and budget it is checked against, never whether it is checked. */
export type GuideOrigin = "model" | "authored";
/** Where an answer comes from. Only `remote` leaves the device. */
export type SupportTransport = "none" | "on-device" | "remote";

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
  /** Runs a compiled guide as a tour: one step at a time, at the person's pace. */
  runGuide(program: GuideProgram, origin: GuideOrigin): Promise<GuideOutcome>;
  /** Tour controls. Each is a no-op when no tour is listening. */
  nextStep(): void;
  backStep(): void;
  restartGuide(): void;
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

/**
 * How the engine is built. `offline` is a gate (ADR 0166): no agent loader is
 * asked for anything, so nothing can answer from a model and nothing can leave
 * the device — the written help and the authored tours are all it has.
 */
export type EngineOptions = { readonly offline?: boolean };

/** Everything the engine is made of, imported together on first open. */
async function loadModules(offline: boolean) {
  const loaders = offline ? ABSENT_AGENT_LOADERS : supportAgentLoaders;
  const [
    { SupportError, createSupportSession, redactionWarning },
    { compileGuide, AUTHORED_GUIDE_LIMITS },
    { createGuideRuntime, systemGuideClock },
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
    import("@opensesame/support-agent").then(
      ({ SupportError, createSupportSession, redactionWarning }) => ({
        SupportError,
        createSupportSession,
        redactionWarning,
      }),
    ),
    import("@opensesame/guide-lang").then(
      ({ compileGuide, AUTHORED_GUIDE_LIMITS }) => ({
        compileGuide,
        AUTHORED_GUIDE_LIMITS,
      }),
    ),
    import("@opensesame/guide-runtime").then(
      ({ createGuideRuntime, systemGuideClock }) => ({
        createGuideRuntime,
        systemGuideClock,
      }),
    ),
    import("@opensesame/app-core/tutorial/registry/context.js"),
    import("@opensesame/app-core/tutorial/registry/targets.js"),
    import("@opensesame/app-core/tutorial/registry/routes.js"),
    import("@opensesame/app-core/tutorial/registry/state.js"),
    import("./coach/scroll-renderer.js"),
    loaders.promptApi(),
    loaders.agUi(),
    import("@opensesame/app-core/tutorial/registry/predicates.js"),
    import("@opensesame/app-core/lib/connectivity-monitor.js"),
  ]);
  return {
    SupportError,
    createSupportSession,
    redactionWarning,
    compileGuide,
    AUTHORED_GUIDE_LIMITS,
    createGuideRuntime,
    systemGuideClock,
    context,
    targets,
    routes,
    predicateState,
    rendering,
    promptApi,
    agUi,
    predicates,
    connectivity,
  };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

async function localAvailability(
  port: SupportAgentPort,
): Promise<SupportAgentAvailability> {
  try {
    return await port.availability();
  } catch {
    return { kind: "unavailable", reason: "platform_unsupported" };
  }
}

/** Whichever agent this browser can actually reach, and where it answers from. */
async function chooseAgent(mods: Modules, offline: boolean) {
  /** Stands in when this browser has neither, so the panel still opens. */
  const absent = {
    availability: (): Promise<SupportAgentAvailability> =>
      Promise.resolve({ kind: "unavailable", reason: "no_local_model" }),
    run: () =>
      Promise.reject(
        new mods.SupportError(
          "AGENT_UNAVAILABLE",
          "no support agent is available in this browser",
        ),
      ),
    destroy: () => {},
  };
  if (offline) return { port: absent, transport: "none" as const };
  const local = mods.promptApi.createPromptApiAgent();
  const providerMod = await supportAgentLoaders.provider();
  const provider = providerMod.createProviderAgent();
  const chosen = chooseSupportAgent(
    local,
    local === null ? null : await localAvailability(local),
    provider,
    () => mods.agUi.createAgUiAgent(),
    absent,
  );
  // Keep unused planes from holding a second live session.
  if (chosen.port !== local) local?.destroy();
  if (chosen.port !== provider) provider?.destroy();
  return chosen;
}

/** The deterministic runtime, over the registries this build declares. */
function buildRuntime(mods: Modules, host: SupportHost) {
  const { targets, routes, predicateState } = mods;
  const renderer = mods.rendering.createScrollRenderer({
    resolveElement: targets.resolveGuideTargetElement,
    reducedMotion: () =>
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      false,
  });
  const runtime = mods.createGuideRuntime({
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
    clock: mods.systemGuideClock(),
  });
  return { renderer, runtime };
}

export async function loadBrowserEngine(
  host: SupportHost,
  options: EngineOptions = {},
): Promise<SupportEngine> {
  const offline = options.offline === true;
  const mods = await loadModules(offline);
  const { SupportError, compileGuide, AUTHORED_GUIDE_LIMITS, context } = mods;
  mods.predicates.registerGuidePredicates();
  const { port, transport } = await chooseAgent(mods, offline);

  function readContext(question?: string) {
    const planes = mods.connectivity.connectivitySnapshot();
    const input: PageContextInput = {
      pageId: "pages",
      route: host.currentRoute(),
      hostReachable: false, // ADR 0090/0128: no Host
      identityReachable: planes.identity.health === "reachable",
    };
    if (question === undefined) return context.buildSupportPageContext(input);
    return context.buildSupportPageContext({ ...input, question });
  }

  // Authored walkthroughs can name controls on their next destination.
  const authoredVocabulary = {
    goals: guideGoalIds(),
    targets: guideTargetIds(),
    routes: GUIDE_ROUTES.map((route) => route.id),
    predicates: guidePredicateIds(),
  };

  // Model vocabulary follows the current page on every compile, not a snapshot.
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

  const session = mods.createSupportSession({ port, vocabulary, readContext });
  const { renderer, runtime } = buildRuntime(mods, host);

  return {
    transport,
    warning: transport === "remote" ? mods.redactionWarning() : null,
    session,
    compile(source) {
      const result = compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    compileAuthored(source) {
      const result = compileGuide(
        source,
        authoredVocabulary,
        AUTHORED_GUIDE_LIMITS,
      );
      return result.ok ? result.program : null;
    },
    ...tourRunner(runtime, AUTHORED_GUIDE_LIMITS),
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
        await mods.promptApi.acquirePromptApiModel(onProgress);
        return { kind: "acquired" };
      } catch (cause) {
        if (cause instanceof SupportError) {
          return { kind: "failed", code: cause.code };
        }
        return { kind: "failed", code: "AGENT_UNAVAILABLE" };
      }
    },
    destroy() {
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
      mods.promptApi.releaseLocalModelSession();
    },
  };
}
