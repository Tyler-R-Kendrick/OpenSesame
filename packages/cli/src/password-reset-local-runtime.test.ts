import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserDriver,
  CandidateCustody,
  type Observation,
  type ResetRun,
} from "@opensesame/cua-password-reset";
import type { PasswordMethod } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_LOCAL_MODULE,
  type PasswordResetConfiguration,
  loadResetConfiguration,
} from "./password-reset-config.js";
import {
  createLocalPasswordResetEffects,
  resetRecipeHostnames,
} from "./password-reset-local-runtime.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import type { ResetVault } from "./password-reset-vault.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const ORIGIN = "http://127.0.0.1:4317";

function recipeJson() {
  return JSON.stringify({
    schemaVersion: 1,
    review: "approved",
    domain: "127.0.0.1",
    entryPath: "/reset",
    allowedOrigins: [ORIGIN],
    verification: {
      path: "/account",
      expectedLabel: "Sign out",
      loginPath: "/login",
      loginLabel: "Sign in",
    },
    steps: [
      { id: "open", primitive: "navigate", path: "/reset" },
      {
        id: "identify",
        primitive: "fill-field",
        ref: "e1",
        expectedLabel: "Email",
        purpose: "identifier",
      },
      { id: "mail", primitive: "await-email-link" },
      {
        id: "password",
        primitive: "fill-field",
        ref: "e3",
        expectedLabel: "New password",
        purpose: "new-password",
      },
      {
        id: "submit",
        primitive: "submit",
        ref: "e4",
        expectedLabel: "Save password",
      },
      { id: "verify", primitive: "verify-login" },
    ],
  });
}

async function configDir(config: PasswordResetConfiguration) {
  const directory = await mkdtemp(join(tmpdir(), "reset-local-"));
  directories.push(directory);
  await writeFile(join(directory, "recipe.json"), recipeJson());
  await writeFile(join(directory, "reset.json"), JSON.stringify(config));
  return directory;
}

function bundledConfig(): PasswordResetConfiguration {
  return {
    schemaVersion: 1,
    origin: ORIGIN,
    itemId: "item-1",
    transport: "cdp",
    recipe: "recipe.json",
    runtime: { module: BUNDLED_LOCAL_MODULE, maxSteps: 40 },
  };
}

describe("bundled local runtime config", () => {
  it("loads with no external module, model plane, or cloud account", async () => {
    const directory = await configDir(bundledConfig());
    const command: PasswordResetCommand = {
      name: "password-reset",
      action: "run",
      config: join(directory, "reset.json"),
      flags: { json: true },
    };
    const loaded = await loadResetConfiguration(command);
    expect(loaded.config.runtime.module).toBe(BUNDLED_LOCAL_MODULE);
    expect(loaded.recipe.domain).toBe("127.0.0.1");
  });

  it("still refuses plain http for non-loopback origins", async () => {
    const config = {
      ...bundledConfig(),
      origin: "http://accounts.example.test",
    };
    const directory = await configDir(config);
    const command: PasswordResetCommand = {
      name: "password-reset",
      action: "run",
      config: join(directory, "reset.json"),
      flags: { json: true },
    };
    await expect(loadResetConfiguration(command)).rejects.toThrow();
  });

  it("still requires the model plane for external runtime modules", async () => {
    const config = {
      ...bundledConfig(),
      origin: "https://accounts.example.test",
      runtime: { module: "runtime.mjs", maxSteps: 40 },
    };
    const directory = await configDir(config);
    const command: PasswordResetCommand = {
      name: "password-reset",
      action: "run",
      config: join(directory, "reset.json"),
      flags: { json: true },
    };
    await expect(loadResetConfiguration(command)).rejects.toThrow();
  });
});

function fieldsFor(path: string): Observation["fields"] {
  if (path === "/reset/link")
    return [
      { ref: "e3", kind: "password", label: "New password" },
      { ref: "e4", kind: "button", label: "Save password" },
    ];
  if (path === "/reset")
    return [
      { ref: "e1", kind: "email", label: "Email" },
      { ref: "e2", kind: "button", label: "Send reset link" },
    ];
  return [];
}

function fakeDriver() {
  let path = "/reset";
  const driver: BrowserDriver = {
    open: vi.fn(async (url: string) => {
      path = new URL(url).pathname;
    }),
    snapshot: vi.fn(async () => ({
      id: crypto.randomUUID(),
      origin: ORIGIN,
      fields: fieldsFor(path),
    })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async () => {}),
    pageUrl: vi.fn(async () => new URL(path, ORIGIN).href),
    close: vi.fn(async () => {}),
  };
  return driver;
}

const METHOD: PasswordMethod = {
  id: "password-1",
  type: "password",
  generator: {
    id: "derived",
    counter: 1,
    rules: {
      length: 24,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      minDigits: 1,
      minSymbols: 1,
    },
  },
  pepper: true,
  pepperAt: "end",
  secret: Buffer.alloc(32, 7).toString("base64"),
  changedAt: "2026-10-28T00:00:00.000Z",
};

function localContext(maxSteps = 40): ResetRuntimeContext {
  const config = {
    ...bundledConfig(),
    runtime: { module: BUNDLED_LOCAL_MODULE, maxSteps },
  };
  const run: ResetRun = {
    id: "run-1",
    domain: "127.0.0.1",
    origin: ORIGIN,
    itemId: "item-1",
    transport: "cdp",
    grantIds: {},
    cursor: 0,
    status: "running",
    updatedAt: "2026-10-28T00:00:00.000Z",
    recipe: JSON.parse(recipeJson()),
  };
  // SAFETY: the local runtime never reads the vault store.
  const store = {} as ResetVault["store"];
  // SAFETY: the local runtime reads only the item id and username.
  const item = {
    id: "item-1",
    username: "person@example.test",
  } as ResetVault["item"];
  return {
    run,
    candidate: new CandidateCustody(
      METHOD,
      () => "person-pepper",
      () => {},
    ),
    item,
    store,
    loaded: { config, directory: "/tmp", recipe: run.recipe },
    agent: {
      headers: vi.fn(async () => ({
        authorization: "Bearer [REDACTED]",
        "x-opensesame-agent-client": crypto.randomUUID(),
        "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-host" as const,
      })),
      forget: vi.fn(),
    },
  };
}

function localSandbox(driver: ReturnType<typeof fakeDriver>) {
  return {
    browser: driver,
    session: "cua-test",
    close: vi.fn(async () => {}),
  };
}

describe("bundled local runtime effects", () => {
  it("drives a full recipe with vault identifier and injected mailbox", async () => {
    const driver = fakeDriver();
    const context = localContext();
    const { run } = context;
    const expectedPassword = await context.candidate.withPassword(
      async (password) => password,
    );
    const effects = await createLocalPasswordResetEffects(context, {
      sandbox: localSandbox(driver),
      mailbox: { resetLink: async () => `${ORIGIN}/reset/link?token=x` },
      verifyLogin: async () => true,
    });
    for (const step of run.recipe.steps) {
      const receipt = await effects.execute(step, run, {
        effectId: step.id,
        attempt: 1,
      });
      expect(receipt.outcome).toBe("completed");
    }
    expect(driver.fill).toHaveBeenCalledWith("e1", "person@example.test");
    expect(driver.fillSecret).toHaveBeenCalledWith("e3", expectedPassword);
    expect(
      await effects.verifyCandidate(run, { effectId: "v", attempt: 1 }),
    ).toBe("verified");
    expect(await effects.compensate(run, { effectId: "c", attempt: 1 })).toBe(
      "unsupported",
    );
  });

  it("refuses to fill credentials after an unexpected origin redirect", async () => {
    const driver = fakeDriver();
    driver.snapshot = vi.fn(
      async (): Promise<Observation> => ({
        id: "redirected",
        origin: "http://127.0.0.1:9999/login",
        fields: [
          { ref: "e1", kind: "email", label: "Email" },
          { ref: "e2", kind: "password", label: "Password" },
          { ref: "e3", kind: "button", label: "Sign in" },
        ],
      }),
    );
    const context = localContext();
    const effects = await createLocalPasswordResetEffects(context, {
      sandbox: localSandbox(driver),
    });
    expect(
      await effects.verifyCandidate(context.run, { effectId: "v", attempt: 1 }),
    ).toBe("unknown");
    expect(driver.fillSecret).not.toHaveBeenCalled();
  });

  it("requires the authenticated landing page instead of accepting an error page", async () => {
    const driver = fakeDriver();
    let submitted = false;
    driver.snapshot = vi.fn(
      async (): Promise<Observation> => ({
        id: crypto.randomUUID(),
        origin: `${ORIGIN}/login`,
        fields: submitted
          ? []
          : [
              { ref: "e1", kind: "email", label: "Email" },
              { ref: "e2", kind: "password", label: "Password" },
              { ref: "e3", kind: "button", label: "Sign in" },
            ],
      }),
    );
    driver.click = vi.fn(async () => {
      submitted = true;
    });
    const context = localContext();
    const effects = await createLocalPasswordResetEffects(context, {
      sandbox: localSandbox(driver),
    });
    expect(
      await effects.verifyCandidate(context.run, { effectId: "v", attempt: 1 }),
    ).toBe("unknown");
  });

  it("closes the browser on a terminal pre-submit failure", async () => {
    const driver = fakeDriver();
    const sandbox = localSandbox(driver);
    const context = localContext();
    const effects = await createLocalPasswordResetEffects(context, { sandbox });
    const receipt = await effects.execute(
      { id: "missing", primitive: "submit", ref: "e404" },
      context.run,
      { effectId: "missing", attempt: 1 },
    );
    expect(receipt.outcome).toBe("failed_before_submit");
    expect(sandbox.close).toHaveBeenCalledOnce();
  });

  it("includes every approved reset-link hostname", () => {
    const context = localContext();
    context.run.recipe.allowedOrigins.push("https://idp.example.test");
    expect(resetRecipeHostnames(context.run.recipe)).toEqual([
      "127.0.0.1",
      "idp.example.test",
    ]);
  });

  it("rejects an approved recipe beyond the configured step budget", async () => {
    const driver = fakeDriver();
    await expect(
      createLocalPasswordResetEffects(localContext(1), {
        sandbox: localSandbox(driver),
      }),
    ).rejects.toThrow("step budget");
  });

  it("refuses to start without approved verification metadata", async () => {
    const context = localContext();
    context.run.recipe.verification = undefined;
    const driver = fakeDriver();
    await expect(
      createLocalPasswordResetEffects(context, {
        sandbox: localSandbox(driver),
      }),
    ).rejects.toThrow("requires verification metadata");
    expect(driver.open).not.toHaveBeenCalled();
  });
});
