import type { InvestigateParams } from "./deepsec-headless-agent-types.js";
import {
  capInvokeTimeoutToFileWall,
  grokDeepMaxTurns,
  grokDeepTimeoutSec,
  grokFileWallSec,
  grokShallowMaxTurns,
  grokShallowTimeoutSec,
  runGrokPromptWithMeta,
  startFileWallAbortScope,
  type GrokFileWallContext,
} from "./grok-agent-prompt.js";
import { runHeadlessInvestigateOnce } from "./grok-headless-investigate-once.js";
import {
  bumpGrokDepthSummary,
  readGrokDepthSummary,
} from "./grok-wave2-depth-summary.js";

type AgentOptions = {
  type: string;
  providerLabel: string;
  defaultModel: string;
};

type InvestigateReturn = {
  results: Array<{
    filePath: string;
    findings: Array<Record<string, unknown>>;
  }>;
  meta: {
    durationMs: number;
    agentType: string;
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    };
    numTurns?: number;
    codexStderr?: string;
  };
};

type PassOutcome = {
  value: InvestigateReturn;
  lastCap: boolean;
  lastTimedOut: boolean;
};

async function* runPass(
  params: InvestigateParams,
  agentOptions: AgentOptions,
  maxTurns: number,
  timeoutSec: number,
  passSignal?: AbortSignal,
  fileWall?: GrokFileWallContext,
): AsyncGenerator<unknown, PassOutcome> {
  let lastCap = false;
  let lastTimedOut = false;
  const gen = runHeadlessInvestigateOnce(params, {
    ...agentOptions,
    runPrompt: async (rp) => {
      const run = await runGrokPromptWithMeta({
        ...rp,
        maxTurns,
        timeoutSec,
        signal: passSignal,
        fileWall,
      });
      lastCap = run.capHit;
      lastTimedOut = run.timedOut;
      if (!run.text.trim() && (run.timedOut || run.capHit)) {
        throw new Error(
          run.timedOut
            ? `grok investigate timed out after ${timeoutSec}s (DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC)`
            : `grok max turns (${maxTurns}) exceeded`,
        );
      }
      return run.text;
    },
  });

  for (;;) {
    const step = await gen.next();
    if (step.done) {
      return {
        value: step.value as InvestigateReturn,
        lastCap,
        lastTimedOut,
      };
    }
    yield step.value;
  }
}

function limitMessage(
  cap: boolean,
  timedOut: boolean,
  shallowMax: number,
): string {
  if (cap) {
    return `turn cap (${shallowMax})`;
  }
  if (timedOut) {
    return "timeout";
  }
  return "error";
}

async function* drainPass(
  gen: AsyncGenerator<unknown, PassOutcome>,
): AsyncGenerator<unknown, PassOutcome> {
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      return step.value;
    }
    yield step.value;
  }
}

function emptyOutcome(
  agentOptions: AgentOptions,
  cap: boolean,
  timedOut: boolean,
): PassOutcome {
  return {
    value: {
      results: [],
      meta: {
        durationMs: 0,
        agentType: agentOptions.type,
        model: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    },
    lastCap: cap,
    lastTimedOut: timedOut,
  };
}

async function* runShallowPass(
  params: InvestigateParams,
  agentOptions: AgentOptions,
  shallowMax: number,
  shallowTimeout: number,
  fileWallSignal: AbortSignal,
  fileWallCtx: GrokFileWallContext,
): AsyncGenerator<unknown, PassOutcome> {
  try {
    return yield* drainPass(
      runPass(
        params,
        agentOptions,
        shallowMax,
        shallowTimeout,
        fileWallSignal,
        fileWallCtx,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut =
      msg.includes("DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC") ||
      msg.includes("DEEPSEC_GROK_FILE_WALL_SEC") ||
      fileWallSignal.aborted;
    const cap = msg.includes("max turns");
    if (!timedOut && !cap) {
      throw err;
    }
    return emptyOutcome(agentOptions, cap, timedOut);
  }
}

/** Leave headroom so deep CLI timeout fires before the per-file wall aborts. */
const WALL_HEADROOM_SEC = 30;

function deepBudgetOrThrow(
  fileWallCtx: GrokFileWallContext,
  deepTimeout: number,
): number {
  const deepBudgetSec = capInvokeTimeoutToFileWall(
    deepTimeout,
    fileWallCtx,
    WALL_HEADROOM_SEC,
  );
  if (deepBudgetSec < 60) {
    throw new Error(
      `grok file wall: only ${Math.floor(
        deepBudgetSec,
      )}s budget for deep pass (need >= 60s; DEEPSEC_GROK_FILE_WALL_SEC)`,
    );
  }
  return deepBudgetSec;
}

function batchHasOnlyZeroCandidates(
  batch: InvestigateParams["batch"],
): boolean {
  return (
    batch.length > 0 &&
    batch.every((f) => (f.candidates?.length ?? 0) === 0)
  );
}

function zeroCandidateShallowMaxTurns(defaultMax: number): number {
  const n = Number(process.env.DEEPSEC_GROK_ZERO_CANDIDATE_SHALLOW_TURNS ?? "25");
  if (!Number.isFinite(n) || n <= 0) {
    return Math.min(defaultMax, 25);
  }
  return Math.min(defaultMax, Math.floor(n));
}

function zeroCandidateShallowTimeoutSec(defaultSec: number): number {
  const n = Number(
    process.env.DEEPSEC_GROK_ZERO_CANDIDATE_SHALLOW_TIMEOUT_SEC ?? "420",
  );
  if (!Number.isFinite(n) || n <= 0) {
    return Math.min(defaultSec, 420);
  }
  return Math.min(defaultSec, Math.floor(n));
}

function rescueMaxTurns(): number {
  const n = Number(process.env.DEEPSEC_GROK_RESCUE_MAX_TURNS ?? "20");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

function rescueTimeoutSec(): number {
  const n = Number(process.env.DEEPSEC_GROK_RESCUE_TIMEOUT_SEC ?? "420");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 420;
}

async function* runDeepWithRescue(
  params: InvestigateParams,
  agentOptions: AgentOptions,
  deepMax: number,
  deepBudgetSec: number,
  shallowOutcome: PassOutcome,
  shallowMax: number,
  passSignal: AbortSignal,
  fileWallCtx: GrokFileWallContext,
): AsyncGenerator<unknown, InvestigateReturn> {
  try {
    const deepOutcome = yield* drainPass(
      runPass(
        params,
        agentOptions,
        deepMax,
        deepBudgetSec,
        passSignal,
        fileWallCtx,
      ),
    );
    bumpGrokDepthSummary({ deepCompleted: 1 });
    return finalizeDeepOutcome(
      deepOutcome,
      shallowOutcome,
      shallowMax,
      deepMax,
    );
  } catch (deepErr) {
    const rescueTurns = rescueMaxTurns();
    const rescueBudgetSec = capInvokeTimeoutToFileWall(
      rescueTimeoutSec(),
      fileWallCtx,
      WALL_HEADROOM_SEC,
    );
    if (rescueBudgetSec < 60) {
      throw deepErr;
    }
    yield {
      type: "started",
      message: `Deep pass failed — rescue investigate (${rescueTurns} turns, ${rescueBudgetSec}s)`,
    };
    const rescueOutcome = yield* drainPass(
      runPass(
        params,
        agentOptions,
        rescueTurns,
        rescueBudgetSec,
        passSignal,
        fileWallCtx,
      ),
    );
    bumpGrokDepthSummary({ deepCompleted: 1 });
    const finalized = finalizeDeepOutcome(
      rescueOutcome,
      shallowOutcome,
      shallowMax,
      rescueTurns,
    );
    return {
      ...finalized,
      meta: {
        ...finalized.meta,
        codexStderr: `rescue_ok;${finalized.meta.codexStderr ?? ""}`,
      },
    };
  }
}

function finalizeDeepOutcome(
  deepOutcome: PassOutcome,
  shallowOutcome: PassOutcome | undefined,
  shallowMax: number,
  deepMax: number,
): InvestigateReturn {
  const shallowTag = shallowOutcome?.lastCap ? "turn_cap" : "timeout";
  const baseUsage = deepOutcome.value.meta.usage;
  const outputFloor = Math.max(
    1,
    baseUsage.outputTokens,
    Math.ceil(JSON.stringify(deepOutcome.value.results).length / 4),
  );
  return {
    ...deepOutcome.value,
    meta: {
      ...deepOutcome.value.meta,
      numTurns: deepMax,
      usage: {
        ...baseUsage,
        outputTokens: outputFloor,
        inputTokens: Math.max(1, baseUsage.inputTokens),
      },
      codexStderr: `deep_ok;shallow_${shallowTag}:${shallowMax}`,
    },
  };
}

export async function* grokWave2Investigate(
  params: InvestigateParams,
  agentOptions: AgentOptions,
) {
  const shallowMaxBase = grokShallowMaxTurns();
  const zeroCandidates = batchHasOnlyZeroCandidates(params.batch);
  const shallowMax = zeroCandidates
    ? zeroCandidateShallowMaxTurns(shallowMaxBase)
    : shallowMaxBase;
  const deepMax = grokDeepMaxTurns();
  const shallowTimeoutBase = grokShallowTimeoutSec();
  const shallowTimeout = zeroCandidates
    ? zeroCandidateShallowTimeoutSec(shallowTimeoutBase)
    : shallowTimeoutBase;
  const fileWallSec = grokFileWallSec();
  const deepTimeout = Math.min(
    grokDeepTimeoutSec(),
    Math.max(60, fileWallSec - shallowTimeout - WALL_HEADROOM_SEC),
  );
  const fileWallCtx: GrokFileWallContext = {
    startedAtMs: Date.now(),
    wallSec: fileWallSec,
  };
  const wallScope = startFileWallAbortScope(fileWallCtx);
  try {
    const shallowBudgetSec = capInvokeTimeoutToFileWall(
      shallowTimeout,
      fileWallCtx,
      WALL_HEADROOM_SEC,
    );
    const shallowOutcome = yield* runShallowPass(
      params,
      agentOptions,
      shallowMax,
      shallowBudgetSec,
      wallScope.signal,
      fileWallCtx,
    );
    if (!shallowOutcome.lastCap && !shallowOutcome.lastTimedOut) {
      return {
        ...shallowOutcome.value,
        meta: { ...shallowOutcome.value.meta, codexStderr: "shallow_ok" },
      };
    }

    bumpGrokDepthSummary({ shallowCapOrTimeout: 1, deepRetries: 1 });
    const deepBudgetSec = deepBudgetOrThrow(fileWallCtx, deepTimeout);
    yield {
      type: "started",
      message: `Shallow ${limitMessage(shallowOutcome.lastCap, shallowOutcome.lastTimedOut, shallowMax)} — re-investigating with ${deepMax} Grok turns (${deepBudgetSec}s budget)`,
    };

    return yield* runDeepWithRescue(
      params,
      agentOptions,
      deepMax,
      deepBudgetSec,
      shallowOutcome,
      shallowMax,
      wallScope.signal,
      fileWallCtx,
    );
  } finally {
    wallScope.stop();
  }
}

export function logGrokDepthSummaryLine(): string {
  const s = readGrokDepthSummary();
  return `grok depth summary: shallow_cap_or_timeout=${s.shallowCapOrTimeout} deep_retries=${s.deepRetries} deep_completed=${s.deepCompleted}`;
}
