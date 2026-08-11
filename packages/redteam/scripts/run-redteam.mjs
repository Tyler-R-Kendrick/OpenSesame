#!/usr/bin/env node
/**
 * Supervisor for `pnpm --filter @opensesame/redteam redteam`.
 *
 * Starts the fixed-port stub Host API / daemon the prompt-injection provider's
 * live-spawned mcp-host needs (see mock-upstream-daemon.mjs for why it has to
 * be fixed-port rather than per-test), runs `promptfoo eval`, then tears the
 * stub down regardless of the eval's outcome. The confused-deputy /
 * credential-exfiltration / malformed-input classes start their own private
 * stub per test call and don't need this — if you only want those (e.g. no
 * model credentials available), run `pnpm --filter @opensesame/redteam
 * redteam:eval` directly instead, which skips this supervisor entirely.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixedPortUpstream } from "./mock-upstream-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(__dirname, "..");

async function main() {
  let upstream;
  try {
    upstream = await startFixedPortUpstream();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `\nredteam: could not start the fixture Host API / daemon on 127.0.0.1:8787 and 127.0.0.1:18790 (${message}).\nThe prompt-injection test class needs those ports free to stand in for a real Host API / daemon. Stop whatever is already listening there (a real 'pnpm dev', another redteam run, etc.) and try again.\n\nThe other three test classes (confused-deputy, credential-exfiltration, malformed-input) don't depend on this stub and need no model credentials either. You can still run the full suite with 'pnpm --filter @opensesame/redteam redteam:eval' once the ports are free — or accept that only the prompt-injection cases will fail with a connection error, which is expected without this stub.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.error(
    "redteam: fixture Host API / daemon up on 127.0.0.1:8787 and 127.0.0.1:18790; " +
      "running promptfoo eval...",
  );

  const child = spawn(
    "pnpm",
    ["exec", "promptfoo", "eval", "-c", "promptfooconfig.yaml"],
    {
      cwd: PACKAGE_DIR,
      stdio: "inherit",
      env: process.env,
    },
  );

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (e) => {
      console.error(
        `redteam: failed to launch promptfoo (${e.message}). Has 'pnpm install' been run?`,
      );
      resolve(1);
    });
  });

  await upstream.close();
  process.exitCode = exitCode;
}

await main();
