import type { PasswordAgent } from "@opensesame/app-core/lib/password-agent/index.js";
import { describe, expect, it, vi } from "vitest";
import type { CliAppIntegrationPort } from "./cli-app-integration-client.js";
import { type ParityContext, runChild, runEnv } from "./parity-commands.js";
import { createCredentialStore } from "./parity-credentials.js";

function agentWithRun(run: PasswordAgent["run"]): PasswordAgent {
  return (
    // SAFETY: runChild only invokes agent.run; the stub implements that method.
    { run } as PasswordAgent
  );
}

function agentWithBroker(
  runBrokered: PasswordAgent["runBrokered"],
  run: PasswordAgent["run"] = async () => 0,
): PasswordAgent {
  return (
    // SAFETY: runChild invokes agent.runBrokered or agent.run; the stub
    // implements both so a test can prove which lane ran.
    { runBrokered, run } as PasswordAgent
  );
}

function agentWithRunFile(runFile: PasswordAgent["runFile"]): PasswordAgent {
  return (
    // SAFETY: runEnv only invokes agent.runFile after approval; the stub implements that method.
    { runFile } as PasswordAgent
  );
}

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
    const agent = agentWithRun(run);
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
    const agent = agentWithRun(run);
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
    const agent = agentWithRunFile(runFile);
    await expect(
      runEnv({
        ...baseCtx({ agent, appIntegration: denyPort }),
        args: ["run", "./env.file"],
      }),
    ).rejects.toThrow(/denied/i);
    expect(runFile).not.toHaveBeenCalled();
  });
});

describe("parity run --agent-proxy", () => {
  const approvePort: CliAppIntegrationPort = {
    ensureReveal: async () => "approve",
  };
  const brokerArgs = [
    "--agent-proxy",
    "--env",
    "TOKEN=os://vault/connections%2Facme%2Fvercel/password",
    "--paths",
    "TOKEN=/v2/user",
    "--methods",
    "TOKEN=GET",
  ];

  it("routes --agent-proxy to the broker lane with its scope flags", async () => {
    const runBrokered = vi.fn(async () => 0);
    const run = vi.fn(async () => 0);
    const agent = agentWithBroker(runBrokered, run);
    await expect(
      runChild(
        baseCtx({ agent, appIntegration: approvePort, args: [...brokerArgs] }),
      ),
    ).resolves.toBe(0);
    expect(runBrokered).toHaveBeenCalledWith(
      [
        {
          name: "TOKEN",
          reference: "os://vault/connections%2Facme%2Fvercel/password",
        },
      ],
      ["node", "-e", "0"],
      ["TOKEN=/v2/user"],
      ["TOKEN=GET"],
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses --agent-proxy with --mount before any lane runs", async () => {
    const runBrokered = vi.fn(async () => 0);
    const run = vi.fn(async () => 0);
    const agent = agentWithBroker(runBrokered, run);
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: approvePort,
          args: [...brokerArgs, "--mount", "CERT=os://vault/item/cert"],
        }),
      ),
    ).rejects.toThrow(/--agent-proxy.*--mount|--mount.*--agent-proxy/);
    expect(runBrokered).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses --paths without --agent-proxy", async () => {
    const runBrokered = vi.fn(async () => 0);
    const agent = agentWithBroker(runBrokered);
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: approvePort,
          args: ["--env", "TOKEN=op://vault/item/field", "--paths", "TOKEN=/x"],
        }),
      ),
    ).rejects.toThrow(/--agent-proxy/);
    expect(runBrokered).not.toHaveBeenCalled();
  });
});
