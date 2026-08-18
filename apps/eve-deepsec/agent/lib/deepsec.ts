import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { deepsecRoot } from "./paths";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 80_000;

export type DeepsecRun = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n…truncated…`;
}

export function deepsecReady(): string | null {
  if (!existsSync(deepsecRoot)) {
    return "missing .deepsec/ workspace";
  }
  if (!existsSync(join(deepsecRoot, "node_modules", "deepsec"))) {
    return "deepsec not installed — run: pnpm --dir .deepsec install";
  }
  return null;
}

export function runDeepsec(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DeepsecRun> {
  const blocked = args.find((a) => a === "process" || a === "sandbox");
  if (blocked) {
    return Promise.resolve({
      ok: false,
      code: 2,
      stdout: "",
      stderr:
        "refused: do not run deepsec process/sandbox from this agent (paid Pi/Gateway path). Investigate with repo_read instead.",
    });
  }

  const notReady = deepsecReady();
  if (notReady) {
    return Promise.resolve({
      ok: false,
      code: 1,
      stdout: "",
      stderr: notReady,
    });
  }

  return new Promise((resolvePromise) => {
    const child = spawn("pnpm", ["deepsec", ...args], {
      cwd: deepsecRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `\ntimed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0,
        code,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
