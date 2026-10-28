import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
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

/** Wall-clock per-file budget (shallow + deep share one deadline). */
export type GrokFileWallContext = {
  startedAtMs: number;
  wallSec: number;
};

export function grokWallRemainingSec(ctx: GrokFileWallContext): number {
  const elapsed = (Date.now() - ctx.startedAtMs) / 1000;
  return Math.max(0, ctx.wallSec - elapsed);
}

export function assertFileWallRemaining(
  ctx: GrokFileWallContext,
  headroomSec = 5,
): void {
  if (grokWallRemainingSec(ctx) <= headroomSec) {
    throw new Error(
      `grok file wall exceeded ${ctx.wallSec}s (DEEPSEC_GROK_FILE_WALL_SEC)`,
    );
  }
}

/** Cap a single grok CLI invoke so shallow + deep cannot exceed the file wall. */
export function capInvokeTimeoutToFileWall(
  invokeTimeoutSec: number,
  ctx: GrokFileWallContext,
  headroomSec: number,
): number {
  assertFileWallRemaining(ctx, headroomSec);
  const budget = Math.floor(grokWallRemainingSec(ctx) - headroomSec);
  return Math.min(invokeTimeoutSec, Math.max(1, budget));
}

let activeGrokChild: ReturnType<typeof spawn> | null = null;

export function killActiveGrokChild(): void {
  if (!activeGrokChild) {
    return;
  }
  killGrokTree(activeGrokChild);
  activeGrokChild = null;
}

const DEEPSEC_GROK_INVOKE_Pgrep =
  "grok -p You are running inside the deepsec";

function readProcPpid(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s*(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function readProcCmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

/** True when `pid` is still owned by a live deepsec process slice (not an orphan). */
export function grokPidHasLiveDeepsecProcessAncestor(
  pid: number,
  maxDepth = 16,
): boolean {
  let cur = pid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const ppid = readProcPpid(cur);
    if (ppid === null || ppid <= 1) {
      return false;
    }
    const cmd = readProcCmdline(ppid);
    if (
      cmd.includes("deepsec/dist/cli.mjs") &&
      cmd.includes("process") &&
      cmd.includes("opensesame")
    ) {
      return true;
    }
    if (cmd.includes("node_modules/.bin/deepsec") && cmd.includes("process")) {
      return true;
    }
    cur = ppid;
  }
  return false;
}

/** Kill detached grok investigate children that outlived their parent slice. */
export function killOrphanDeepsecGrokInvokes(): number {
  if (process.platform === "win32") {
    return 0;
  }
  let raw = "";
  try {
    raw = execFileSync("pgrep", ["-f", DEEPSEC_GROK_INVOKE_Pgrep], {
      encoding: "utf8",
    }).trim();
  } catch {
    return 0;
  }
  const pids = raw
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 1)
    .filter((pid) => !grokPidHasLiveDeepsecProcessAncestor(pid));
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    const graceMs = Math.max(
      1000,
      Number(process.env.DEEPSEC_GROK_KILL_GRACE_MS ?? "10000"),
    );
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }, graceMs);
    timer.unref?.();
  }
  return pids.length;
}

/** Poll wall-clock deadline; kills the active grok process group when exceeded. */
export function startFileWallAbortScope(ctx: GrokFileWallContext): {
  signal: AbortSignal;
  stop: () => void;
} {
  const controller = new AbortController();
  const onExceeded = () => {
    if (controller.signal.aborted) {
      return;
    }
    killActiveGrokChild();
    controller.abort(
      new Error(
        `grok file wall exceeded ${ctx.wallSec}s (DEEPSEC_GROK_FILE_WALL_SEC)`,
      ),
    );
  };
  const interval = setInterval(() => {
    if (grokWallRemainingSec(ctx) <= 0) {
      onExceeded();
    }
  }, 1000);
  if (grokWallRemainingSec(ctx) <= 0) {
    onExceeded();
  }
  return {
    signal: controller.signal,
    stop: () => clearInterval(interval),
  };
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

/** SIGTERM the process group, then SIGKILL after the configured grace window. */
export function killGrokTree(child: ReturnType<typeof spawn>): void {
  const graceMs = Math.max(
    1000,
    Number(process.env.DEEPSEC_GROK_KILL_GRACE_MS ?? "10000"),
  );
  killGrokGroup(child, "SIGTERM");
  const pid = child.pid;
  if (!pid) {
    return;
  }
  const timer = setTimeout(() => {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // fall through
      }
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, graceMs);
  timer.unref?.();
}

/** Latest time a single grok invoke may run before we hard-kill and settle. */
export function grokInvokeHardCapMs(
  invokeTimeoutSec: number,
  killGraceMs: number,
  fileWall?: GrokFileWallContext,
): number {
  const perInvokeMs = invokeTimeoutSec * 1000 + killGraceMs + 5000;
  if (!fileWall) {
    return perInvokeMs;
  }
  const wallMs =
    Math.max(0, grokWallRemainingSec(fileWall) * 1000) + killGraceMs + 5000;
  return Math.min(perInvokeMs, wallMs);
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
    hardInvokeTimer: ReturnType<typeof setTimeout>,
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
  let hardInvokeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    clearTimeout(watchdog);
    clearTimeout(killTimer);
    clearTimeout(hardInvokeTimer);
  };
  return {
    isSettled: () => settled,
    setTimers: (w, k, h) => {
      watchdog = w;
      killTimer = k;
      hardInvokeTimer = h;
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
  params: RunPromptParams & {
    maxTurns: number;
    timeoutSec?: number;
    fileWall?: GrokFileWallContext;
  },
): Promise<GrokPromptRunResult> {
  const killGraceMs = Number(process.env.DEEPSEC_GROK_KILL_GRACE_MS ?? "10000");
  const killGraceSec = Math.ceil(killGraceMs / 1000) + 5;
  let timeoutSec = params.timeoutSec ?? grokInvestigateTimeoutSec();
  if (params.fileWall) {
    timeoutSec = capInvokeTimeoutToFileWall(
      timeoutSec,
      params.fileWall,
      killGraceSec,
    );
  }
  const timeoutMs = timeoutSec * 1000;
  const maxTurns = params.maxTurns;

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
    activeGrokChild = child;
    const clearActiveChild = () => {
      if (activeGrokChild === child) {
        activeGrokChild = null;
      }
    };
    const io = { stdout: "", stderr: "" };
    const settler = makeGrokSettler(child, resolve, reject);
    const { finish, fail } = settler;
    const finishWrapped = (result: GrokPromptRunResult) => {
      clearActiveChild();
      finish(result);
    };
    const failWrapped = (err: Error) => {
      clearActiveChild();
      fail(err);
    };

    let wallPollStop: (() => void) | undefined;
    const fileWallCtx = params.fileWall;
    if (fileWallCtx) {
      const wallPoll = setInterval(() => {
        if (settler.isSettled()) {
          return;
        }
        if (grokWallRemainingSec(fileWallCtx) <= 0) {
          killGrokTree(child);
          finishWrapped({
            text: io.stdout,
            capHit: detectGrokCapHit(io.stderr, io.stdout, maxTurns),
            timedOut: true,
            stderr: `${io.stderr}\n[deepsec] grok file wall exceeded ${fileWallCtx.wallSec}s (DEEPSEC_GROK_FILE_WALL_SEC)`,
          });
        }
      }, 1000);
      wallPollStop = () => clearInterval(wallPoll);
    }

    const hardCapMs = grokInvokeHardCapMs(timeoutSec, killGraceMs, fileWallCtx);
    const hardInvokeTimer = setTimeout(() => {
      if (settler.isSettled()) {
        return;
      }
      killGrokTree(child);
      finishWrapped({
        text: io.stdout,
        capHit: detectGrokCapHit(io.stderr, io.stdout, maxTurns),
        timedOut: true,
        stderr: `${io.stderr}\n[deepsec] grok invoke hard cap ${hardCapMs}ms (DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC / DEEPSEC_GROK_FILE_WALL_SEC)`,
      });
    }, hardCapMs);

    // Hard kill only after the grace window: with coreutils, `timeout -k`
    // owns the TERM-then-KILL sequence; without it, killTimer sends the
    // group SIGTERM at timeoutMs. Previously the watchdog SIGKILL raced
    // the SIGTERM at the same instant, so the grace never applied.
    const watchdog = setTimeout(() => {
      killGrokTree(child);
      finishWrapped({
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
    settler.setTimers(watchdog, killTimer, hardInvokeTimer);

    const onAbort = () => {
      killGrokTree(child);
      if (timeoutSignal.aborted) {
        finishWrapped({
          text: io.stdout,
          capHit: detectGrokCapHit(io.stderr, io.stdout, maxTurns),
          timedOut: true,
          stderr: io.stderr,
        });
        return;
      }
      const reason = signal.reason;
      const wallExceeded =
        reason instanceof Error &&
        reason.message.includes("DEEPSEC_GROK_FILE_WALL_SEC");
      if (wallExceeded) {
        finishWrapped({
          text: io.stdout,
          capHit: detectGrokCapHit(io.stderr, io.stdout, maxTurns),
          timedOut: true,
          stderr: reason.message,
        });
        return;
      }
      failWrapped(
        reason instanceof Error ? reason : new Error("aborted"),
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
      wallPollStop?.();
      failWrapped(err);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      wallPollStop?.();
      if (settler.isSettled()) {
        clearActiveChild();
        return;
      }
      settler.clearTimers();
      handleGrokClose(code, io, maxTurns, finishWrapped, failWrapped);
    });
  });
}
