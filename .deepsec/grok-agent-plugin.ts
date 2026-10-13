/**
 * deepsec agent backend: Grok Build CLI (subscription), headless via `grok -p`.
 * deepsec 2.3.6 has no native grok agent; this plugin registers `--agent grok`.
 *
 * Auth: `unset XAI_API_KEY` then `grok login --device-auth` (subscription).
 * Do not rely on XAI_API_KEY unless explicitly approved (per-token billing).
 */
import { spawn } from "node:child_process";
import type { DeepsecPlugin } from "deepsec/config";
import {
  DEFAULT_GROK_MODEL,
  type RunPromptParams,
  createHeadlessDeepsecAgent,
  extractTextFromAgentStdout,
} from "./deepsec-headless-agent-core.js";

function grokEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.XAI_API_KEY = undefined;
  env.GROK_DEPLOYMENT_KEY = undefined;
  return env;
}

function runGrokPrompt(params: RunPromptParams): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(params.signal.reason ?? new Error("aborted"));
      return;
    }
    const args = [
      "-p",
      params.prompt,
      "-m",
      params.model,
      "--always-approve",
      "--output-format",
      "json",
      "--max-turns",
      String(params.maxTurns ?? 150),
    ];
    const child = spawn("grok", args, {
      cwd: params.cwd,
      env: grokEnv(),
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
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `grok exited ${code}`));
        return;
      }
      try {
        const merged =
          stdout + (stderr.includes("Not signed in") ? `\n${stderr}` : "");
        resolve(extractTextFromAgentStdout(merged, "Not signed in"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const GrokAgent = createHeadlessDeepsecAgent({
  type: "grok",
  providerLabel: "Grok Build",
  defaultModel: DEFAULT_GROK_MODEL,
  runPrompt: runGrokPrompt,
});

export const grokAgentPlugin: DeepsecPlugin = {
  name: "opensesame-grok-build",
  agents: [new GrokAgent()],
};
