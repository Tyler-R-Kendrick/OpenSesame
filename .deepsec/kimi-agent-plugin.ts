/**
 * deepsec agent backend: Kimi Code CLI (subscription OAuth), headless via `kimi -p`.
 * Registers `--agent kimi`. No Moonshot API keys — credentials in ~/.kimi-code only.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeepsecPlugin } from "deepsec/config";
import {
  DEFAULT_KIMI_MODEL,
  type RunPromptParams,
  createHeadlessDeepsecAgent,
  extractTextFromAgentStdout,
} from "./deepsec-headless-agent-core.js";

const KIMI_BIN_CANDIDATES = [join(homedir(), ".local", "bin", "kimi"), "kimi"];

export function resolveKimiBin(): string | null {
  for (const candidate of KIMI_BIN_CANDIDATES) {
    if (candidate === "kimi") {
      const which = spawnSync("command", ["-v", "kimi"], {
        encoding: "utf8",
        shell: true,
        env: kimiEnv(),
      });
      if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim();
      }
      continue;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function kimiCredentialsPresent(): boolean {
  return existsSync(
    join(homedir(), ".kimi-code", "credentials", "kimi-code.json"),
  );
}

function kimiEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const localBin = join(homedir(), ".local", "bin");
  env.PATH = env.PATH?.includes(localBin)
    ? env.PATH
    : `${localBin}:${env.PATH ?? ""}`;
  env.MOONSHOT_API_KEY = undefined;
  env.XAI_API_KEY = undefined;
  env.GROK_DEPLOYMENT_KEY = undefined;
  env.OPENAI_API_KEY = undefined;
  env.ANTHROPIC_API_KEY = undefined;
  return env;
}

function stripKimiSessionFooter(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("kimi version ")) continue;
    if (line.startsWith("To resume this session:")) break;
    if (line.trim() === "•" || line.trim() === "") continue;
    out.push(line.replace(/^•\s*/, ""));
  }
  return out.join("\n").trim();
}

function runKimiPrompt(params: RunPromptParams): Promise<string> {
  const bin = resolveKimiBin();
  if (!bin) {
    return Promise.reject(
      new Error(
        "kimi CLI not found (~/.local/bin/kimi). Install Kimi Code CLI and run kimi login.",
      ),
    );
  }
  if (!kimiCredentialsPresent()) {
    return Promise.reject(
      new Error(
        "Kimi Code is not signed in (~/.kimi-code/credentials/kimi-code.json missing).",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(params.signal.reason ?? new Error("aborted"));
      return;
    }
    const args = [
      "-m",
      params.model,
      "-p",
      params.prompt,
      "--output-format",
      "text",
    ];
    const child = spawn(bin, args, {
      cwd: params.cwd,
      env: kimiEnv(),
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
      const combined = stdout || stderr;
      if (code !== 0 && !combined.trim()) {
        reject(new Error(stderr.trim() || `kimi exited ${code}`));
        return;
      }
      const quota =
        /quota|rate limit|too many requests|usage limit/i.test(combined) &&
        !/\bOK\b/.test(combined);
      if (quota) {
        reject(
          new Error(`kimi quota or rate limit: ${combined.slice(0, 400)}`),
        );
        return;
      }
      const text = stripKimiSessionFooter(combined);
      try {
        resolve(extractTextFromAgentStdout(text));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const KimiAgent = createHeadlessDeepsecAgent({
  type: "kimi",
  providerLabel: "Kimi Code",
  defaultModel: DEFAULT_KIMI_MODEL,
  runPrompt: runKimiPrompt,
});

export const kimiAgentPlugin: DeepsecPlugin = {
  name: "opensesame-kimi-code",
  agents: [new KimiAgent()],
};
