/**
 * Executes one manifest step: bounded by a timeout, killed as a whole process
 * group on timeout or on our own termination, its output captured, sanitized
 * and hashed, and its test counts parsed so that an empty selection can never
 * be reported as `passed` (AT-EVIDENCE-NORUN).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sanitize } from "./mtls-sanitize.mjs";

const CARGO_RESULT =
  /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g;
const CARGO_RUNNING = /^running (\d+) tests?$/gm;
const VITEST_TESTS = /^\s*Tests\s+(?:(\d+) failed \| )?(\d+) passed/gm;
const VITEST_FAILED_ONLY = /^\s*Tests\s+(\d+) failed\b/gm;
const VITEST_NONE = /No test files found/;
// Free-form scripts (node, bash) report through this marker line.
const MARKER =
  /MTLS_TESTS\s+passed=(\d+)\s+failed=(\d+)(?:\s+not_executed=(\d+))?/g;

function emptyCounts() {
  return { passed: 0, failed: 0, ignored: 0, not_executed: 0, selected: null };
}

function parseCargo(log) {
  const c = emptyCounts();
  let sawResult = false;
  for (const m of log.matchAll(CARGO_RESULT)) {
    sawResult = true;
    c.passed += Number(m[2]);
    c.failed += Number(m[3]);
    c.ignored += Number(m[4]);
  }
  let selected = 0;
  let sawRunning = false;
  for (const m of log.matchAll(CARGO_RUNNING)) {
    sawRunning = true;
    selected += Number(m[1]);
  }
  if (sawRunning) c.selected = selected;
  else if (sawResult) c.selected = c.passed + c.failed;
  return c;
}

function parseVitest(log) {
  const c = emptyCounts();
  if (VITEST_NONE.test(log)) {
    c.selected = 0;
    return c;
  }
  let saw = false;
  for (const m of log.matchAll(VITEST_TESTS)) {
    saw = true;
    c.failed += Number(m[1] ?? 0);
    c.passed += Number(m[2]);
  }
  if (!saw) {
    for (const m of log.matchAll(VITEST_FAILED_ONLY)) {
      saw = true;
      c.failed += Number(m[1]);
    }
  }
  if (saw) c.selected = c.passed + c.failed;
  return c;
}

function parseMarker(log) {
  const c = emptyCounts();
  let saw = false;
  for (const m of log.matchAll(MARKER)) {
    saw = true;
    c.passed += Number(m[1]);
    c.failed += Number(m[2]);
    c.not_executed += Number(m[3] ?? 0);
  }
  if (saw) c.selected = c.passed + c.failed;
  return c;
}

// Every pattern above is anchored against plain text, and a runner that
// believes it is talking to a terminal wraps its summary in SGR escapes —
// which is what CI looks like to vitest, whatever the local shell does. An
// unparsed summary is reported as "nothing ran", so the escapes come off
// before any pattern is applied rather than being suppressed per runner.
// Built rather than written as a literal: the pattern has to match ESC, and a
// control character inside a regular expression is a lint error everywhere
// else it appears, rightly.
const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** Strip SGR/cursor escapes so a colourized summary parses like a plain one. */
export function decolor(log) {
  return log.replace(ANSI, "");
}

/** @returns {{passed:number, failed:number, ignored:number, not_executed:number, selected:number|null}} */
export function parseTestCounts(runner, log) {
  const plain = decolor(log);
  if (runner === "cargo") return parseCargo(plain);
  if (runner === "vitest") return parseVitest(plain);
  // "marker" and "shell": a script may report counts; a shell step need not.
  return parseMarker(plain);
}

/**
 * Decide a step's result from its exit code and counts. A required step with
 * nothing selected, everything ignored, or an unparseable runner output is a
 * failure, not a pass.
 */
export function judge({ runner, required, exitCode, counts, timedOut }) {
  if (timedOut) return { result: "failed", reason: "timed out" };
  if (exitCode !== 0)
    return { result: "failed", reason: `exit code ${exitCode}` };
  if (counts.failed > 0)
    return { result: "failed", reason: `${counts.failed} test(s) failed` };
  const parsesCounts =
    runner === "cargo" || runner === "vitest" || runner === "marker";
  if (parsesCounts) {
    if (counts.selected === null) {
      return required
        ? {
            result: "failed",
            reason: "no test summary in output (nothing ran?)",
          }
        : { result: "not_executed", reason: "no test summary in output" };
    }
    if (counts.passed === 0) {
      const why =
        counts.ignored > 0
          ? `all ${counts.ignored} selected tests were ignored`
          : "empty test selection (0 passed)";
      return required
        ? { result: "failed", reason: why }
        : { result: "not_executed", reason: why };
    }
  }
  return { result: "passed", reason: null };
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run `argv` (argv[0] is the program) with a hard timeout, in its own process
 * group, and write the sanitized combined output to `logPath`.
 * @returns {Promise<{exitCode:number|null, timedOut:boolean, durationMs:number, log:string, logSha256:string, redactions:Record<string,number>}>}
 */
export function runBounded(argv, { cwd, env, timeoutMs, logPath, echo }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const onSignal = () => {
      killGroup(child, "SIGTERM");
      setTimeout(() => {
        killGroup(child, "SIGKILL");
        process.exit(130);
      }, 2_000).unref();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("exit", () => killGroup(child, "SIGKILL"));
    const collect = (buf) => {
      chunks.push(buf);
      if (echo) process.stderr.write(buf);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) =>
      chunks.push(Buffer.from(`\n[spawn error] ${err.message}\n`)),
    );
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      const raw = Buffer.concat(chunks).toString("utf8");
      const { text, redactions } = sanitize(raw);
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, text);
      resolve({
        exitCode: code === null ? (signal ? 128 : null) : code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        log: text,
        logSha256: sha256Hex(text),
        redactions,
      });
    });
  });
}
