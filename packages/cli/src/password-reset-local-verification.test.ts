import {
  type BrowserDriver,
  CandidateCustody,
  type Observation,
  type ResetRun,
} from "@opensesame/cua-password-reset";
import type { PasswordMethod } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { BUNDLED_LOCAL_MODULE } from "./password-reset-config.js";
import { createLocalPasswordResetEffects } from "./password-reset-local-runtime.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import type { ResetVault } from "./password-reset-vault.js";

const ORIGIN = "http://127.0.0.1:4317";
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

function context(loginPath = "/login"): ResetRuntimeContext {
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
    recipe: {
      schemaVersion: 1,
      review: "approved",
      domain: "127.0.0.1",
      entryPath: "/reset",
      allowedOrigins: [ORIGIN],
      verification: {
        path: "/account",
        expectedLabel: "Sign out",
        loginPath,
        loginLabel: "Sign in",
      },
      steps: [{ id: "verify", primitive: "verify-login" }],
    },
  };
  const config = {
    schemaVersion: 1 as const,
    origin: ORIGIN,
    itemId: "item-1",
    transport: "cdp" as const,
    recipe: "recipe.json",
    runtime: { module: BUNDLED_LOCAL_MODULE, maxSteps: 40 },
  };
  // SAFETY: the verification runtime reads only the item id and username.
  const item = {
    id: "item-1",
    username: "person@example.test",
  } as ResetVault["item"];
  // SAFETY: the local runtime never reads the vault store.
  const store = {} as ResetVault["store"];
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

function driver(path: string, fields: Observation["fields"]): BrowserDriver {
  return {
    open: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({
      id: crypto.randomUUID(),
      origin: ORIGIN,
      fields,
    })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async () => {}),
    pageUrl: vi.fn(async () => new URL(path, ORIGIN).href),
    close: vi.fn(async () => {}),
  };
}

function sandbox(browser: BrowserDriver, session: string) {
  return { browser, session, close: vi.fn(async () => {}) };
}

describe("local login verification", () => {
  it("uses the approved login path and email field among unrelated controls", async () => {
    const current = context("/signin");
    let submitted = false;
    const browser = driver("/signin", [
      { ref: "e1", kind: "email", label: "Email" },
      { ref: "e2", kind: "text", label: "Site search" },
      { ref: "e3", kind: "password", label: "Password" },
      { ref: "e4", kind: "button", label: "Sign in" },
      { ref: "e5", kind: "link", label: "Forgot password" },
    ]);
    browser.open = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe("/signin");
    });
    browser.click = vi.fn(async () => {
      submitted = true;
    });
    browser.snapshot = vi.fn(
      async (): Promise<Observation> => ({
        id: crypto.randomUUID(),
        origin: ORIGIN,
        fields: submitted
          ? [{ ref: "e6", kind: "link", label: "Sign out" }]
          : [
              { ref: "e1", kind: "email", label: "Email" },
              { ref: "e2", kind: "text", label: "Site search" },
              { ref: "e3", kind: "password", label: "Password" },
              { ref: "e4", kind: "button", label: "Sign in" },
              { ref: "e5", kind: "link", label: "Forgot password" },
            ],
      }),
    );
    browser.pageUrl = vi.fn(
      async () => new URL(submitted ? "/account" : "/signin", ORIGIN).href,
    );
    const resetBrowser = driver("/reset", []);
    const effects = await createLocalPasswordResetEffects(current, {
      sandbox: sandbox(resetBrowser, "reset-session"),
      verificationSandbox: sandbox(browser, "verify-session"),
    });
    expect(
      await effects.verifyCandidate(current.run, { effectId: "v", attempt: 1 }),
    ).toBe("verified");
    expect(browser.fill).toHaveBeenCalledWith("e1", "person@example.test");
    expect(resetBrowser.open).not.toHaveBeenCalled();
  });

  it("uses verification-specific instructions while completing a challenge", async () => {
    const current = context();
    let path = "/login";
    const browser = driver(path, []);
    browser.open = vi.fn(async (url: string) => {
      path = new URL(url).pathname;
    });
    browser.pageUrl = vi.fn(async () => new URL(path, ORIGIN).href);
    browser.snapshot = vi.fn(
      async (): Promise<Observation> => ({
        id: crypto.randomUUID(),
        origin: ORIGIN,
        fields:
          path === "/login"
            ? [
                { ref: "e1", kind: "email", label: "Email" },
                { ref: "e2", kind: "password", label: "Password" },
                { ref: "e3", kind: "button", label: "Sign in" },
              ]
            : path === "/challenge"
              ? [{ ref: "e4", kind: "otp", label: "Authenticator code" }]
              : [{ ref: "e5", kind: "link", label: "Sign out" }],
      }),
    );
    browser.click = vi.fn(async () => {
      path = "/challenge";
    });
    const notify = vi.fn();
    const effects = await createLocalPasswordResetEffects(current, {
      sandbox: sandbox(driver("/reset", []), "reset-session"),
      verificationSandbox: sandbox(browser, "verify-session"),
      notify,
      readSecretLine: async () => {
        path = "/account";
        return "";
      },
    });
    expect(
      await effects.verifyCandidate(current.run, { effectId: "v", attempt: 1 }),
    ).toBe("verified");
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toContain("verification browser");
    expect(notify.mock.calls[0]?.[0]).not.toContain("reset-session");
    expect(notify.mock.calls[0]?.[0]).not.toContain("run resume");
  });
});
