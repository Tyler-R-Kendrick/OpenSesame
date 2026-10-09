/**
 * deepsec agent backend: Cursor Agent CLI with grok-4.7 (Cursor subscription).
 * Registers `--agent cursor` when `cursor-agent` is on PATH and authenticated.
 *
 * Does not use XAI_API_KEY, AI Gateway, or other pay-per-token routes.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeepsecPlugin } from "deepsec/config";
import {
  DEFAULT_GROK_MODEL,
  type RunPromptParams,
  createHeadlessDeepsecAgent,
  extractTextFromAgentStdout,
} from "./deepsec-headless-agent-core.js";

const CURSOR_AGENT_CANDIDATES = [
  "cursor-agent",
  join(homedir(), ".local", "bin", "cursor-agent"),
  join(homedir(), ".cursor", "bin", "cursor-agent"),
];

export function resolveCursorAgentBin(): string | null {
  const which = spawnSync("command", ["-v", "cursor-agent"], {
    encoding: "utf8",
    shell: true,
  });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  for (const candidate of CURSOR_AGENT_CANDIDATES) {
    if (candidate !== "cursor-agent" && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function cursorEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.XAI_API_KEY = undefined;
  env.GROK_DEPLOYMENT_KEY = undefined;
  env.OPENAI_API_KEY = undefined;
  env.ANTHROPIC_API_KEY = undefined;
  return env;
}

function runCursorPrompt(params: RunPromptParams): Promise<string> {
  const bin = resolveCursorAgentBin();
  if (!bin) {
    return Promise.reject(
      new Error(
        "cursor-agent not found on PATH (~/.local/bin or ~/.cursor/bin). Install the Cursor CLI and sign in on this machine.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(params.signal.reason ?? new Error("aborted"));
      return;
    }
    const args = [
      "-p",
      params.prompt,
      "--model",
      params.model,
      "--print",
      "--force",
    ];
    const child = spawn(bin, args, {
      cwd: params.cwd,
      env: cursorEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("aborted"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      params.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", onAbort);
      const authFailed =
        stderr.includes("not authenticated") ||
        stderr.includes("Not logged in") ||
        stderr.includes("login");
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `cursor-agent exited ${code}`));
        return;
      }
      if (authFailed && !stdout.trim()) {
        reject(
          new Error(
            "cursor-agent is not authenticated. Run `cursor-agent login` (or sign in via Cursor) on this VM.",
          ),
        );
        return;
      }
      try {
        resolve(extractTextFromAgentStdout(stdout || stderr));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const CursorAgent = createHeadlessDeepsecAgent({
  type: "cursor",
  providerLabel: "Cursor Agent",
  defaultModel: DEFAULT_GROK_MODEL,
  runPrompt: runCursorPrompt,
});

export const cursorAgentPlugin: DeepsecPlugin = {
  name: "opensesame-cursor-agent",
  agents: [new CursorAgent()],
};
