import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AgentBrowser,
  type AgentBrowserConfig,
  type BrowserDriver,
  BrowserStepExecutor,
  type BrowserStepPorts,
  type ExactFormProxyPort,
} from "./agent-browser.js";
import { ORIGIN, observation } from "./test-support.js";
import type { ProxyProof, RecipeStep, ResetRun } from "./types.js";

const proof: ProxyProof = {
  origin: ORIGIN,
  method: "POST",
  path: "/reset",
  field: "password",
  contentType: "application/json",
  identityEncoding: true,
  untransformedForm: true,
  canaryVerified: true,
};

function run(proxySubstitution?: ProxyProof): ResetRun {
  return {
    id: "run-browser",
    domain: "accounts.example.test",
    origin: ORIGIN,
    itemId: "item-1",
    transport: proxySubstitution ? "proxy" : "cdp",
    grantIds: {},
    cursor: 0,
    status: "running",
    updatedAt: "2026-10-27T00:00:00.000Z",
    recipe: {
      schemaVersion: 1,
      review: "candidate",
      domain: "accounts.example.test",
      entryPath: "/login",
      allowedOrigins: [ORIGIN],
      proxySubstitution,
      steps: [
        {
          id: "password",
          primitive: "fill-field",
          ref: "e3",
          purpose: "new-password",
        },
        { id: "submit", primitive: "submit", ref: "e4" },
      ],
    },
  };
}

function passwordStep(current: ResetRun): RecipeStep {
  const step = current.recipe.steps[0];
  if (!step) throw new Error("Fixture requires a password step");
  return step;
}

type SpawnAnswer = Readonly<{
  output: string;
  code?: number;
  stderr?: string;
}>;

function queueSpawn(outputs: SpawnAnswer[]) {
  const spawn = vi.fn(
    (_executable: string, _args: readonly string[], _options: SpawnOptions) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdio: [null, PassThrough, PassThrough] = [null, stdout, stderr];
      const child = Object.assign(new ChildProcess(), {
        stdin: null,
        stdout,
        stderr,
        stdio,
        kill: vi.fn(),
      });
      const next = outputs.shift() ?? { output: "" };
      process.nextTick(() => {
        child.stderr.end(next.stderr ?? "");
        child.stdout.end(next.output);
        child.emit("close", next.code ?? 0);
      });
      return child;
    },
  );
  return spawn;
}

function config(
  spawn: NonNullable<AgentBrowserConfig["spawn"]>,
): AgentBrowserConfig {
  return {
    executable: "/opt/user/agent-browser",
    session: "reset-run-1",
    allowedDomains: ["accounts.example.test"],
    secretFill: vi.fn(async () => undefined),
    spawn,
  };
}

function driver(): BrowserDriver {
  return {
    open: vi.fn(async () => undefined),
    snapshot: vi.fn(async () =>
      observation([
        { ref: "e1", kind: "email", label: "Email" },
        { ref: "e2", kind: "button", label: "Continue" },
        { ref: "e3", kind: "password", label: "New password" },
        { ref: "e4", kind: "button", label: "Reset password" },
        { ref: "e5", kind: "otp", label: "Authenticator code" },
      ]),
    ),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    fillSecret: vi.fn(async () => undefined),
  };
}

function makePorts(candidateValues: string[] = []) {
  const armed: { synthetic: string; proof: ProxyProof }[] = [];
  const proxy: ExactFormProxyPort = {
    exactFormSubstitution: true,
    arm: async (input) => {
      armed.push({ synthetic: input.synthetic, proof: input.proof });
    },
  };
  const ports: BrowserStepPorts = {
    identifier: async () => "person@example.test",
    mailbox: {
      resetLink: async () => `${ORIGIN}/reset?token=OPAQUE_MAIL_CAPABILITY`,
    },
    candidate: {
      withPassword: async <T>(use: (password: string) => Promise<T>) => {
        candidateValues.push("real");
        return use("REAL_PASSWORD_CANARY");
      },
      withSynthetic: async <T>(
        _proof: ProxyProof,
        use: (synthetic: string) => Promise<T>,
      ) => {
        candidateValues.push("synthetic");
        return use("SYNTHETIC_PASSWORD");
      },
    },
    takeover: {
      handoff: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
    },
    authorizeProxy: vi.fn(),
    proxy,
    verifyLogin: async () => true,
  };
  return { ports, proxy, armed };
}

describe("agent-browser adapter", () => {
  it("uses a fenced session and keeps secrets out of commands and snapshots", async () => {
    const url = JSON.stringify({
      success: true,
      data: { url: `${ORIGIN}/reset?token=DO_NOT_EXPOSE` },
    });
    const snapshot = JSON.stringify({
      success: true,
      data: {
        snapshot: "New password FIELD_CANARY",
        refs: {
          e1: { role: "textbox", name: "New password", value: "FIELD_CANARY" },
        },
      },
    });
    const spawn = queueSpawn([
      { output: "" },
      { output: url },
      { output: snapshot },
      { output: "" },
      { output: "" },
    ]);
    const cfg = config(spawn);
    const browser = new AgentBrowser(cfg);
    await browser.open(`${ORIGIN}/reset?token=MAIL_CAPABILITY`);
    const current = await browser.snapshot();
    await browser.click("e1");
    await browser.fill("e1", "IDENTIFIER_CANARY");
    await browser.fillSecret("e1", "REAL_PASSWORD_CANARY");

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      cfg.executable,
      [
        "--session",
        cfg.session,
        "--allowed-domains",
        "accounts.example.test",
        "--max-output",
        "1000000",
        "--no-webmcp",
        "open",
        `${ORIGIN}/reset?token=MAIL_CAPABILITY`,
      ],
      expect.objectContaining({ shell: false }),
    );
    expect(current.fields).toEqual([
      { ref: "e1", kind: "password", label: "New password" },
    ]);
    expect(JSON.stringify(current)).not.toContain("CANARY");
    expect(cfg.secretFill).toHaveBeenCalledWith("@e1", "REAL_PASSWORD_CANARY");
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(
      "REAL_PASSWORD_CANARY",
    );
  });

  it("does not reflect secret-bearing child stderr into errors", async () => {
    const browser = new AgentBrowser(
      config(
        queueSpawn([{ output: "", code: 1, stderr: "REAL_PASSWORD_CANARY" }]),
      ),
    );
    await expect(browser.open(ORIGIN)).rejects.toThrow(
      /^agent-browser command failed$/,
    );
  });
});

describe("browser primitive executor", () => {
  it("maps navigation, fields, clicks, opaque mail, verification and human waiting", async () => {
    const browser = driver();
    const { ports } = makePorts();
    const executor = new BrowserStepExecutor(browser, ports);
    const current = run();
    const steps: RecipeStep[] = [
      { id: "open", primitive: "navigate", path: "/login" },
      {
        id: "identify",
        primitive: "fill-field",
        ref: "e1",
        purpose: "identifier",
      },
      { id: "request", primitive: "click", ref: "e2" },
      { id: "mail", primitive: "await-email-link" },
      { id: "verify", primitive: "verify-login" },
    ];
    for (const step of steps)
      expect((await executor.execute(step, current)).outcome).toBe("completed");
    for (const primitive of [
      "await-human",
      "enter-email-code",
      "enter-TOTP",
      "passkey-prompt",
    ] as const)
      expect(
        (
          await executor.execute(
            { id: `wait-${primitive}`, primitive },
            current,
          )
        ).outcome,
      ).toBe("waiting");
    expect(browser.open).toHaveBeenCalledWith(`${ORIGIN}/login`);
    expect(browser.open).toHaveBeenCalledWith(
      `${ORIGIN}/reset?token=OPAQUE_MAIL_CAPABILITY`,
    );
    expect(browser.fill).toHaveBeenCalledWith("e1", "person@example.test");
    expect(browser.click).toHaveBeenCalledWith("e2");
  });

  it("fills the real password through the secret port only immediately before submit", async () => {
    const browser = driver();
    const values: string[] = [];
    const { proxy: _proxy, ...ports } = makePorts(values).ports;
    const executor = new BrowserStepExecutor(browser, ports);
    await executor.execute(passwordStep(run()), run());
    expect(browser.fillSecret).toHaveBeenCalledWith(
      "e3",
      "REAL_PASSWORD_CANARY",
    );
    expect(values).toEqual(["real"]);

    const early = run();
    early.recipe.steps[1] = { id: "verify", primitive: "verify-login" };
    await expect(executor.execute(passwordStep(early), early)).rejects.toThrow(
      "immediately before submit",
    );
    expect(values).toEqual(["real"]);
  });

  it("uses synthetic material only on the approved exact-form proxy lane", async () => {
    const browser = driver();
    const values: string[] = [];
    const { ports, armed } = makePorts(values);
    const executor = new BrowserStepExecutor(browser, ports);
    await executor.execute(passwordStep(run(proof)), run(proof));
    expect(values).toEqual(["synthetic"]);
    expect(browser.fill).toHaveBeenCalledWith("e3", "SYNTHETIC_PASSWORD");
    expect(armed).toEqual([{ synthetic: "SYNTHETIC_PASSWORD", proof }]);

    const { proxy: _disabled, ...noProxyPorts } = makePorts(values).ports;
    await expect(
      new BrowserStepExecutor(browser, noProxyPorts).execute(
        passwordStep(run(proof)),
        run(proof),
      ),
    ).rejects.toThrow("unavailable");
    expect(values).toEqual(["synthetic"]);
  });
});
