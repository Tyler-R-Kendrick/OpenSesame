import { spawn } from "node:child_process";
import { extractTextFromAgentStdout } from "./deepsec-agent-stdout.js";
import type { RunPromptParams } from "./deepsec-headless-agent-types.js";

export type GrokPromptRunResult = {
  text: string;
  capHit: boolean;
  timedOut: boolean;
  stderr: string;
};

export function grokEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.XAI_API_KEY = undefined;
  env.GROK_CODE_XAI_API_KEY = undefined;
  env.GROK_DEPLOYMENT_KEY = undefined;
  return env;
}

export function grokShallowMaxTurns(): number {
  const n = Number(
    process.env.DEEPSEC_GROK_SHALLOW_MAX_TURNS ??
      process.env.DEEPSEC_GROK_MAX_TURNS ??
      "60",
  );
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

export function grokDeepMaxTurns(): number {
  const n = Number(process.env.DEEPSEC_GROK_DEEP_MAX_TURNS ?? "150");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 150;
}

/** Per grok CLI invocation (default 2700s, aligned with the wave-2 file wall). */
export function grokInvestigateTimeoutSec(): number {
  const n = Number(process.env.DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC ?? "2700");
  return Number.isFinite(n) && n > 0 ? n : 2700;
}

export function grokShallowTimeoutSec(): number {
  const n = Number(
    process.env.DEEPSEC_GROK_SHALLOW_TIMEOUT_SEC ??
      String(Math.min(600, grokInvestigateTimeoutSec())),
  );
  return Number.isFinite(n) && n > 0 ? n : 600;
}

export function grokDeepTimeoutSec(): number {
  const wall = Number(process.env.DEEPSEC_GROK_FILE_WALL_SEC ?? "2700");
  const per = Number(
    process.env.DEEPSEC_GROK_DEEP_TIMEOUT_SEC ??
      String(Math.max(300, wall - grokShallowTimeoutSec())),
  );
  return Number.isFinite(per) && per > 0 ? per : 900;
}

export function grokFileWallSec(): number {
  const n = Number(process.env.DEEPSEC_GROK_FILE_WALL_SEC ?? "2700");
  return Number.isFinite(n) && n > 0 ? n : 2700;
}

/**
 * Grace between SIGTERM and the watchdog SIGKILL. Guarded like the other
 * budgets: an invalid value must never yield NaN, which would make
 * `timeout -k NaN` invalid and fire the watchdog setTimeout immediately.
 */
export function grokKillGraceMs(): number {
  const raw = process.env.DEEPSEC_GROK_KILL_GRACE_MS;
  const n = raw === undefined || raw === "" ? 10000 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10000;
}

function combineAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal,
): AbortSignal {
  if (!primary) {
    return secondary;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([primary, secondary]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (primary.aborted) {
    controller.abort(primary.reason);
    return controller.signal;
  }
  primary.addEventListener("abort", onAbort, { once: true });
  secondary.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function detectGrokCapHit(
  stderr: string,
  stdout: string,
  maxTurns: number,
): boolean {
  const blob = `${stderr}\n${stdout}`;
  if (
    /exceeded max turns|max turns exceeded|hit the turn limit|turn limit reached|max_turns/i.test(
      blob,
    )
  ) {
    return true;
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      num_turns?: number;
      turns?: number;
      usage?: { num_turns?: number };
    };
    const turns =
      parsed.num_turns ?? parsed.turns ?? parsed.usage?.num_turns ?? null;
    if (typeof turns === "number" && turns >= maxTurns) {
      return true;
    }
  } catch {
    // plain text response
  }
  return false;
}

/**
 * Signal the child's whole process group. The child is always spawned
 * detached on POSIX, so its pid is the group id and `kill(-pid)` reaches
 * `timeout` and the `grok` grandchild alike. On Windows there is no group
 * kill; fall back to terminating the direct child only.
 */
export function killGrokGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // group already gone; fall through to the direct child
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function killGrokTree(child: ReturnType<typeof spawn>): void {
  killGrokGroup(child, "SIGKILL");
}

function grokSpawnArgs(
  params: RunPromptParams & { maxTurns: number },
  timeoutSec: number,
  killGraceMs: number,
): { cmd: string; args: string[]; useCoreutils: boolean } {
  const grokArgs = [
    "-p",
    params.prompt,
    "-m",
    params.model,
    "--always-approve",
    "--output-format",
    "json",
    "--max-turns",
    String(params.maxTurns),
  ];
  const useCoreutils =
    process.env.DEEPSEC_GROK_USE_COREUTILS_TIMEOUT !== "0" &&
    process.platform !== "win32";
  if (!useCoreutils) {
    return { cmd: "grok", args: grokArgs, useCoreutils };
  }
  return {
    cmd: "timeout",
    args: [
      "-k",
      String(Math.ceil(killGraceMs / 1000)),
      String(timeoutSec),
      "grok",
      ...grokArgs,
    ],
    useCoreutils,
  };
}

function handleGrokClose(
  code: number | null,
  io: { stdout: string; stderr: string },
  maxTurns: number,
  finish: (result: GrokPromptRunResult) => void,
  fail: (err: Error) => void,
): void {
  const capHit = detectGrokCapHit(io.stderr, io.stdout, maxTurns);
  const timedOut =
    code === 124 ||
    code === 137 ||
    /timed out|timeout|watchdog SIGKILL/i.test(io.stderr);
  if (code !== 0 && !io.stdout.trim() && !timedOut) {
    fail(new Error(io.stderr.trim() || `grok exited ${code}`));
    return;
  }
  let text: string;
  try {
    text = extractTextFromAgentStdout(
      io.stdout + (io.stderr.includes("Not signed in") ? `\n${io.stderr}` : ""),
      "Not signed in",
    );
  } catch (e) {
    fail(e instanceof Error ? e : new Error(String(e)));
    return;
  }
  finish({ text, capHit, timedOut, stderr: io.stderr });
}

type GrokSettler = {
  isSettled: () => boolean;
  finish: (result: GrokPromptRunResult) => void;
  fail: (err: Error) => void;
  setTimers: (
    watchdog: ReturnType<typeof setTimeout>,
    killTimer: ReturnType<typeof setTimeout> | undefined,
  ) => void;
  clearTimers: () => void;
};

function makeGrokSettler(
  child: ReturnType<typeof spawn>,
  resolve: (result: GrokPromptRunResult) => void,
  reject: (err: Error) => void,
): GrokSettler {
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    clearTimeout(watchdog);
    clearTimeout(killTimer);
  };
  return {
    isSettled: () => settled,
    setTimers: (w, k) => {
      watchdog = w;
      killTimer = k;
    },
    clearTimers,
    finish: (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    },
    fail: (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      killGrokTree(child);
      reject(err);
    },
  };
}

export function runGrokPromptWithMeta(
  params: RunPromptParams & { maxTurns: number; timeoutSec?: number },
): Promise<GrokPromptRunResult> {
  const timeoutSec = params.timeoutSec ?? grokInvestigateTimeoutSec();
  const timeoutMs = timeoutSec * 1000;
  const maxTurns = params.maxTurns;
  const killGraceMs = grokKillGraceMs();

  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(params.signal.reason ?? new Error("aborted"));
      return;
    }
    const spawnArgs = grokSpawnArgs(params, timeoutSec, killGraceMs);
    const useCoreutils = spawnArgs.useCoreutils;

    const timeoutSignal = AbortSignal.timeout(timeoutMs + killGraceMs + 5000);
    const signal = combineAbortSignals(params.signal, timeoutSignal);
    const child = spawn(spawnArgs.cmd, spawnArgs.args, {
      cwd: params.cwd,
      env: grokEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Always detached on POSIX so killGrokGroup(-pid) reaches the
      // `timeout` wrapper and its `grok` child; previously the coreutils
      // path was not detached and the group kill missed the grandchild.
      detached: process.platform !== "win32",
    });
    const io = { stdout: "", stderr: "" };
    const settler = makeGrokSettler(child, resolve, reject);
    const { finish, fail } = settler;

    // Hard kill only after the grace window: with coreutils, `timeout -k`
    // owns the TERM-then-KILL sequence; without it, killTimer sends the
    // group SIGTERM at timeoutMs. Previously the watchdog SIGKILL raced
    // the SIGTERM at the same instant, so the grace never applied.
    const watchdog = setTimeout(() => {
      killGrokTree(child);
      finish({
        text: io.stdout,
        capHit: detectGrokCapHit(io.stderr, io.stdout, maxTurns),
        timedOut: true,
        stderr: `${io.stderr}\n[deepsec] grok watchdog SIGKILL after ${timeoutSec}s + ${killGraceMs}ms grace`,
      });
    }, timeoutMs + killGraceMs);

    const killTimer = useCoreutils
      ? undefined
      : setTimeout(() => {
          killGrokGroup(child, "SIGTERM");
        }, timeoutMs);
    settler.setTimers(watchdog, killTimer);

    const onAbort = () => {
      killGrokTree(child);
      if (timeoutSignal.aborted) {
        finish({
          text: io.stdout,
          capHit: detectGrokCapHit(io.stderr, io.stdout, maxTurns),
          timedOut: true,
          stderr: io.stderr,
        });
        return;
      }
      fail(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      io.stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      io.stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      fail(err);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (settler.isSettled()) {
        return;
      }
      settler.clearTimers();
      handleGrokClose(code, io, maxTurns, finish, fail);
    });
  });
}
