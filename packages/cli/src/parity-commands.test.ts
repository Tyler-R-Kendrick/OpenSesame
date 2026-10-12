import type { PasswordAgent } from "@opensesame/app-core/lib/password-agent/index.js";
import { describe, expect, it, vi } from "vitest";
import type { CliAppIntegrationPort } from "./cli-app-integration-client.js";
import { type ParityContext, runChild, runEnv } from "./parity-commands.js";
import { createCredentialStore } from "./parity-credentials.js";

function baseCtx(
  overrides: Partial<ParityContext> & {
    agent: PasswordAgent;
  },
): ParityContext {
  return {
    args: ["--env", "TOKEN=op://vault/item/field"],
    child: ["node", "-e", "0"],
    scope: { desktop: true },
    reveal: true,
    store: createCredentialStore(),
    raw: {
      invoke: async () => "",
      run: async () => 0,
      runEnvFile: async () => 0,
    },
    port: {
      invoke: async () => "",
      run: async () => 0,
      runEnvFile: async () => 0,
    },
    privateInput: async () => "",
    privateFile: async () => {},
    ...overrides,
  };
}

describe("parity run approval", () => {
  it("refuses run without app integration approval and does not spawn the child", async () => {
    const run = vi.fn(async () => 0);
    const denyPort: CliAppIntegrationPort = {
      ensureReveal: async () => "deny",
    };
    // SAFETY: runChild only calls agent.run in this test.
    const agent = { run } as unknown as PasswordAgent;
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: denyPort,
        }),
      ),
    ).rejects.toThrow(/denied/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the child after app integration approves", async () => {
    const run = vi.fn(async () => 0);
    const approvePort: CliAppIntegrationPort = {
      ensureReveal: async () => "approve",
    };
    // SAFETY: runChild only calls agent.run in this test.
    const agent = { run } as unknown as PasswordAgent;
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: approvePort,
        }),
      ),
    ).resolves.toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it("refuses env run without approval and does not read the env file", async () => {
    const runFile = vi.fn(async () => 0);
    const denyPort: CliAppIntegrationPort = {
      ensureReveal: async () => "deny",
    };
    // SAFETY: runEnv only calls agent.runFile after approval in this test.
    const agent = { runFile } as unknown as PasswordAgent;
    await expect(
      runEnv({
        ...baseCtx({ agent, appIntegration: denyPort }),
        args: ["run", "./env.file"],
      }),
    ).rejects.toThrow(/denied/i);
    expect(runFile).not.toHaveBeenCalled();
  });
});
