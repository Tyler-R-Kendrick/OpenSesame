import type { InvestigateParams } from "./deepsec-headless-agent-types.js";
import {
  grokDeepMaxTurns,
  grokDeepTimeoutSec,
  grokFileWallSec,
  grokShallowMaxTurns,
  grokShallowTimeoutSec,
  runGrokPromptWithMeta,
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
  fileWall: AbortSignal,
): AsyncGenerator<unknown, PassOutcome> {
  try {
    return yield* drainPass(
      runPass(params, agentOptions, shallowMax, shallowTimeout, fileWall),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut =
      msg.includes("DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC") || fileWall.aborted;
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
  fileWall: AbortSignal,
  fileWallSec: number,
  fileWallStartedAt: number,
  deepTimeout: number,
): number {
  if (fileWall.aborted) {
    throw new Error(
      `grok file wall exceeded ${fileWallSec}s (DEEPSEC_GROK_FILE_WALL_SEC)`,
    );
  }
  const wallRemainingSec = Math.max(
    0,
    fileWallSec - (Date.now() - fileWallStartedAt) / 1000,
  );
  const deepBudgetSec = Math.min(
    deepTimeout,
    Math.max(0, Math.floor(wallRemainingSec - WALL_HEADROOM_SEC)),
  );
  if (deepBudgetSec < 60) {
    throw new Error(
      `grok file wall: only ${Math.floor(wallRemainingSec)}s left after shallow pass (need >= ${60 + WALL_HEADROOM_SEC}s for deep)`,
    );
  }
  return deepBudgetSec;
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
  const shallowMax = grokShallowMaxTurns();
  const deepMax = grokDeepMaxTurns();
  const shallowTimeout = grokShallowTimeoutSec();
  const fileWallSec = grokFileWallSec();
  const deepTimeout = Math.min(
    grokDeepTimeoutSec(),
    Math.max(60, fileWallSec - shallowTimeout - WALL_HEADROOM_SEC),
  );
  const fileWallStartedAt = Date.now();
  const fileWall = AbortSignal.timeout(fileWallSec * 1000);

  const shallowOutcome = yield* runShallowPass(
    params,
    agentOptions,
    shallowMax,
    shallowTimeout,
    fileWall,
  );
  if (!shallowOutcome.lastCap && !shallowOutcome.lastTimedOut) {
    return {
      ...shallowOutcome.value,
      meta: { ...shallowOutcome.value.meta, codexStderr: "shallow_ok" },
    };
  }

  bumpGrokDepthSummary({ shallowCapOrTimeout: 1, deepRetries: 1 });
  yield {
    type: "started",
    message: `Shallow ${limitMessage(shallowOutcome.lastCap, shallowOutcome.lastTimedOut, shallowMax)} — re-investigating with ${deepMax} Grok turns (${deepTimeout}s budget)`,
  };

  const deepBudgetSec = deepBudgetOrThrow(
    fileWall,
    fileWallSec,
    fileWallStartedAt,
    deepTimeout,
  );
  const deepOutcome = yield* drainPass(
    runPass(params, agentOptions, deepMax, deepBudgetSec, fileWall),
  );
  bumpGrokDepthSummary({ deepCompleted: 1 });
  return finalizeDeepOutcome(deepOutcome, shallowOutcome, shallowMax, deepMax);
}

export function logGrokDepthSummaryLine(): string {
  const s = readGrokDepthSummary();
  return `grok depth summary: shallow_cap_or_timeout=${s.shallowCapOrTimeout} deep_retries=${s.deepRetries} deep_completed=${s.deepCompleted}`;
}
