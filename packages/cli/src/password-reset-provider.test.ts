import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClaimRequiredError } from "@opensesame/agent-sandboxes";
import {
  type BrowserDriver,
  CandidateCustody,
  type ResetRun,
} from "@opensesame/cua-password-reset";
import type { PasswordMethod } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_LOCAL_MODULE,
  type PasswordResetConfiguration,
  loadResetConfiguration,
} from "./password-reset-config.js";
import { createLocalPasswordResetEffects } from "./password-reset-local-runtime.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import {
  createSandboxProvider,
  loadBoatProviderState,
  saveBoatProviderState,
} from "./password-reset-sandbox-provider.js";
import type { ResetVault } from "./password-reset-vault.js";

const ORIGIN = "http://127.0.0.1:4317";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

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
    ],
  });
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

async function configDir(config: PasswordResetConfiguration) {
  const directory = await mkdtemp(join(tmpdir(), "reset-provider-"));
  directories.push(directory);
  await writeFile(join(directory, "recipe.json"), recipeJson());
  await writeFile(join(directory, "reset.json"), JSON.stringify(config));
  return directory;
}

function loadCommand(directory: string) {
  return {
    name: "password-reset" as const,
    action: "run" as const,
    config: join(directory, "reset.json"),
    flags: { json: true },
  };
}

describe("sandbox provider configuration", () => {
  it("loads a bundled config with an explicit sandbox provider", async () => {
    const config: PasswordResetConfiguration = {
      ...bundledConfig(),
      runtime: {
        module: BUNDLED_LOCAL_MODULE,
        maxSteps: 40,
        provider: "cloudflare",
      },
    };
    const loaded = await loadResetConfiguration(
      loadCommand(await configDir(config)),
    );
    expect(loaded.config.runtime.provider).toBe("cloudflare");
  });

  it("refuses Cloudflare allocation before accessing provider credentials", async () => {
    const provider = createSandboxProvider("cloudflare");
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("CDP browser provider is temporarily unavailable");
  });

  it("refuses a sandbox provider on an external runtime module", async () => {
    const config: PasswordResetConfiguration = {
      ...bundledConfig(),
      origin: "https://accounts.example.test",
      runtime: {
        module: "runtime.mjs",
        maxSteps: 40,
        provider: "boat",
        resource: "https://runtime.example.test",
        model: "decision-model",
        modelBaseURL: "https://model.example.test/v1",
        modelKeyEnv: "RESET_MODEL_KEY",
        browser: "/opt/user/agent-browser",
      },
    };
    await expect(
      loadResetConfiguration(loadCommand(await configDir(config))),
    ).rejects.toThrow();
  });

  it("refuses config URLs with embedded credentials", async () => {
    const config: PasswordResetConfiguration = {
      ...bundledConfig(),
      origin: "https://user:secret@accounts.example.test",
    };
    await expect(
      loadResetConfiguration(loadCommand(await configDir(config))),
    ).rejects.toThrow();
  });
});

describe("boat registration state persistence", () => {
  it("round-trips with private file permissions and defaults to empty", async () => {
    const directory = await configDir(bundledConfig());
    expect(loadBoatProviderState(directory)).toEqual({});
    saveBoatProviderState(directory, {
      claimToken: "clm_1",
      identityAssertion: "assert-1",
    });
    expect(loadBoatProviderState(directory)).toEqual({
      claimToken: "clm_1",
      identityAssertion: "assert-1",
    });
    const mode = (await stat(join(directory, ".boat-agent-state.json"))).mode;
    expect(mode & 0o777).toBe(0o600);
  });
});

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

function fakeDriver(): BrowserDriver {
  return {
    open: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({
      id: crypto.randomUUID(),
      origin: ORIGIN,
      fields: [
        { ref: "e1", kind: "email" as const, label: "Email" },
        { ref: "e2", kind: "button" as const, label: "Send reset link" },
      ],
    })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async () => {}),
    pageUrl: vi.fn(async () => `${ORIGIN}/reset`),
    close: vi.fn(async () => {}),
  };
}

function providerContext(): ResetRuntimeContext {
  const config: PasswordResetConfiguration = {
    ...bundledConfig(),
    runtime: { module: BUNDLED_LOCAL_MODULE, maxSteps: 40, provider: "boat" },
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
  // SAFETY: checked at the test boundary: the bundled runtime never reads the vault store.
  const store = {} as ResetVault["store"];
  // SAFETY: checked at the test boundary: the bundled runtime reads only the item id and username.
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
        authorization: ["Bearer", "test"].join(" "),
        "x-opensesame-agent-client": crypto.randomUUID(),
        "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-host" as const,
      })),
      forget: vi.fn(),
    },
  };
}

describe("sandbox provider allocation", () => {
  it("allocates the configured sandbox provider for the run", async () => {
    const driver = fakeDriver();
    const context = providerContext();
    const allocate = vi.fn(async () => ({
      provider: "boat" as const,
      session: "bx_test",
      browser: driver,
      allowedDomains: ["127.0.0.1"],
      close: vi.fn(async () => {}),
    }));
    const effects = await createLocalPasswordResetEffects(context, {
      createProvider: (id) => {
        expect(id).toBe("boat");
        return { id, allocate };
      },
      mailbox: { resetLink: async () => `${ORIGIN}/reset/link?token=x` },
      verifyLogin: async () => true,
    });
    expect(allocate).toHaveBeenCalledWith({
      origin: ORIGIN,
      extraAllowedDomains: ["127.0.0.1"],
      session: "cua-run-1",
    });
    const step = context.run.recipe.steps[0];
    if (!step) throw new Error("recipe step missing");
    const receipt = await effects.execute(step, context.run, {
      effectId: "open",
      attempt: 1,
    });
    expect(receipt.outcome).toBe("completed");
    expect(driver.open).toHaveBeenCalledWith(`${ORIGIN}/reset`);
  });

  it("surfaces a provider claim with its verification link and code", async () => {
    const context = providerContext();
    const messages: string[] = [];
    await expect(
      createLocalPasswordResetEffects(context, {
        createProvider: (id) => ({
          id,
          allocate: async () => {
            throw new SandboxClaimRequiredError({
              verificationUri:
                "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=attempt",
              userCode: "123456",
            });
          },
        }),
        notify: (message) => messages.push(message),
        readSecretLine: async () => {
          expect(messages).toHaveLength(1);
          expect(messages[0]).toContain("claim_attempt_token=attempt");
          expect(messages[0]).not.toContain("123456");
          return "";
        },
      }),
    ).rejects.toEqual(new Error("Sandbox allocation needs a person first"));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("123456");
  });

  it("surfaces a hosted checkout without requesting a claim code", async () => {
    const messages: string[] = [];
    const readSecretLine = vi.fn(async () => "");
    await expect(
      createLocalPasswordResetEffects(providerContext(), {
        createProvider: (id) => ({
          id,
          allocate: async () => {
            throw new SandboxClaimRequiredError({
              verificationUri: "https://checkout.stripe.com/c/pay/cs_test",
            });
          },
        }),
        readSecretLine,
        notify: (message) => messages.push(message),
      }),
    ).rejects.toEqual(new Error("Sandbox allocation needs a person first"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("finish billing");
    expect(readSecretLine).not.toHaveBeenCalled();
  });

  it("does not display a provider-supplied terminal escape or foreign URL", async () => {
    const messages: string[] = [];
    await expect(
      createLocalPasswordResetEffects(providerContext(), {
        createProvider: (id) => ({
          id,
          allocate: async () => {
            throw new SandboxClaimRequiredError({
              verificationUri: "https://evil.example/\u001b[2J",
              userCode: "123456",
            });
          },
        }),
        notify: (message) => messages.push(message),
      }),
    ).rejects.toThrow("Boat returned an invalid human handoff URL");
    expect(messages).toEqual([]);
  });
});
