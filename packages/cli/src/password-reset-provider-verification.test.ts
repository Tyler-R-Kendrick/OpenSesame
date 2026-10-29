import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  WasmRelayProvider,
} from "@opensesame/agent-sandboxes";
import {
  type BrowserDriver,
  CandidateCustody,
  type ResetRun,
} from "@opensesame/cua-password-reset";
import type { PasswordMethod } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_LOCAL_MODULE,
  type PasswordResetConfiguration,
} from "./password-reset-config.js";
import { createLocalPasswordResetEffects } from "./password-reset-local-runtime.js";
import { createLocalLoginVerifier } from "./password-reset-local-verification.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import type { ResetVault } from "./password-reset-vault.js";

const ORIGIN = "https://account.example.test";
const METHOD: PasswordMethod = {
  id: "test",
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

function context(): ResetRuntimeContext {
  const recipe = {
    schemaVersion: 1 as const,
    review: "approved" as const,
    domain: "account.example.test",
    entryPath: "/reset",
    allowedOrigins: [ORIGIN],
    verification: {
      path: "/account",
      expectedLabel: "Sign out",
      loginPath: "/login",
      loginLabel: "Sign in",
    },
    steps: [{ id: "open", primitive: "navigate" as const, path: "/reset" }],
  };
  const config: PasswordResetConfiguration = {
    schemaVersion: 1,
    origin: ORIGIN,
    itemId: "item",
    transport: "cdp",
    recipe: "recipe.json",
    runtime: {
      module: BUNDLED_LOCAL_MODULE,
      maxSteps: 40,
      provider: "wasm-relay",
    },
  };
  const run: ResetRun = {
    id: "run",
    domain: recipe.domain,
    origin: ORIGIN,
    itemId: "item",
    transport: "cdp",
    grantIds: {},
    cursor: 0,
    status: "running",
    updatedAt: "2026-10-28T00:00:00.000Z",
    recipe,
  };
  // SAFETY: The test exercises only the bundled browser path, not the store.
  const store = {} as ResetVault["store"];
  // SAFETY: The browser path reads only this test item's username.
  const item = {
    id: "item",
    username: "person@example.test",
  } as ResetVault["item"];
  return {
    run,
    candidate: new CandidateCustody(
      METHOD,
      () => "pepper",
      () => {},
    ),
    item,
    store,
    loaded: { config, directory: "/tmp", recipe },
    agent: {
      headers: vi.fn(async () => ({
        authorization: "Bearer test",
        "x-opensesame-agent-client": "test",
        "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-host" as const,
      })),
      forget: vi.fn(),
    },
  };
}

function driver(
  initiallyAuthenticated: boolean,
  acceptedPassword: string,
): BrowserDriver {
  let authenticated = initiallyAuthenticated;
  let page = `${ORIGIN}/reset`;
  let submittedPassword = "";
  return {
    open: vi.fn(async (url) => {
      page = url;
    }),
    pageUrl: vi.fn(async () => page),
    snapshot: vi.fn(async () => ({
      id: "snapshot",
      origin: ORIGIN,
      fields:
        page.endsWith("/account") && authenticated
          ? [{ ref: "logout", kind: "button" as const, label: "Sign out" }]
          : [
              { ref: "email", kind: "email" as const, label: "Email" },
              { ref: "password", kind: "password" as const, label: "Password" },
              { ref: "submit", kind: "button" as const, label: "Sign in" },
            ],
    })),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async (_ref, value) => {
      submittedPassword = value;
    }),
    click: vi.fn(async () => {
      if (authenticated || submittedPassword === acceptedPassword) {
        authenticated = true;
        page = `${ORIGIN}/account`;
      }
    }),
    close: vi.fn(async () => {}),
  };
}

const effect = { effectId: "verification", attempt: 1 };
const takeover = { handoff: async () => {}, resume: async () => {} };

describe("remote password verification isolation", () => {
  it("uses a different actual WASM relay cookie-jar session", async () => {
    const test = context();
    const sessions: string[] = [];
    const signedIn = new Set(["cua-run"]);
    const form =
      '<form action="/login" method="post"><input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>';
    const provider = new WasmRelayProvider({
      virtualFetch: async (request) => {
        sessions.push(request.sessionId);
        if (request.method === "POST" && signedIn.has(request.sessionId))
          return {
            status: 200,
            url: `${ORIGIN}/account`,
            headers: {},
            bodyText: "<button>Sign out</button>",
          };
        return {
          status: 200,
          url: `${ORIGIN}/login`,
          headers: {},
          bodyText: form,
        };
      },
    });
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: () => provider,
    });
    expect(await runtime.verifyCandidate(test.run, effect)).toBe("unknown");
    expect(sessions.length).toBeGreaterThan(0);
    expect(
      sessions.every((id) => id.startsWith("cua-verify-") && id !== "cua-run"),
    ).toBe(true);
  });

  it("does not accept a bad candidate just because the reset session is signed in", async () => {
    const test = context();
    const alreadySignedIn = driver(true, "different-password");
    // Reusing the reset browser is a real false-positive control.
    const unsafe = createLocalLoginVerifier(
      test,
      {
        verificationSandbox: {
          browser: alreadySignedIn,
          session: "reset",
          close: async () => {},
        },
      },
      takeover,
    );
    expect(await unsafe.verifyLogin()).toBe(true);

    const requests: SandboxAllocationRequest[] = [];
    const verification = driver(false, "different-password");
    const allocate = vi.fn(
      async (request: SandboxAllocationRequest): Promise<AllocatedSandbox> => {
        requests.push(request);
        return {
          provider: "wasm-relay",
          session: request.session ?? "",
          browser: requests.length === 1 ? alreadySignedIn : verification,
          allowedDomains: ["account.example.test"],
          close: vi.fn(async () => {}),
        };
      },
    );
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: (id) => ({ id, allocate }),
    });
    expect(await runtime.verifyCandidate(test.run, effect)).toBe("unknown");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.session).toBe("cua-run");
    expect(requests[1]?.session).toMatch(/^cua-verify-/u);
    expect(requests[1]?.session).not.toBe(requests[0]?.session);
  });

  it("accepts a correct password in an independent verification session", async () => {
    const test = context();
    let acceptedPassword = "";
    await test.candidate.withPassword(async (value) => {
      acceptedPassword = value;
    });
    let allocations = 0;
    const allocate = vi.fn(
      async (request: SandboxAllocationRequest): Promise<AllocatedSandbox> => {
        allocations += 1;
        return {
          provider: "wasm-relay",
          session: request.session ?? "",
          browser: driver(allocations === 1, acceptedPassword),
          allowedDomains: ["account.example.test"],
          close: vi.fn(async () => {}),
        };
      },
    );
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: (id) => ({ id, allocate }),
    });
    expect(await runtime.verifyCandidate(test.run, effect)).toBe("verified");
    expect(allocations).toBe(2);
  });

  it("surfaces cleanup failure and retries the same allocation", async () => {
    const test = context();
    const messages: string[] = [];
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret detail"))
      .mockResolvedValue(undefined);
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: (id) => ({
        id,
        allocate: async (request) => ({
          provider: "wasm-relay",
          session: request.session ?? "",
          browser: driver(false, ""),
          allowedDomains: [],
          close,
        }),
      }),
      notify: (message) => messages.push(message),
    });
    await expect(runtime.promoteCandidate(test.run, effect)).rejects.toThrow(
      "Sandbox cleanup failed",
    );
    expect(messages.join(" ")).not.toContain("secret detail");
    await expect(
      runtime.promoteCandidate(test.run, effect),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("continues to surface a permanent cleanup failure", async () => {
    const test = context();
    const close = vi.fn(async () => {
      throw new Error("secret detail");
    });
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: (id) => ({
        id,
        allocate: async (request) => ({
          provider: "wasm-relay",
          session: request.session ?? "",
          browser: driver(false, ""),
          allowedDomains: [],
          close,
        }),
      }),
      notify: () => {},
    });
    await expect(runtime.promoteCandidate(test.run, effect)).rejects.toThrow(
      "Sandbox cleanup failed",
    );
    await expect(runtime.promoteCandidate(test.run, effect)).rejects.toThrow(
      "Sandbox cleanup failed",
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("refuses a provider that reuses the reset session", async () => {
    const test = context();
    const reused = driver(true, "wrong");
    const messages: string[] = [];
    const resetClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValue(undefined);
    const duplicateClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValue(undefined);
    let allocations = 0;
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: (id) => ({
        id,
        allocate: async () => {
          allocations += 1;
          return {
            provider: "wasm-relay",
            session: "shared",
            browser: reused,
            allowedDomains: [],
            close: allocations === 1 ? resetClose : duplicateClose,
          };
        },
      }),
      notify: (message) => messages.push(message),
    });
    expect(await runtime.verifyCandidate(test.run, effect)).toBe("unknown");
    expect(messages.join(" ")).toContain("verification was refused");
    expect(reused.fillSecret).not.toHaveBeenCalled();
    expect(resetClose).not.toHaveBeenCalled();
    expect(duplicateClose).not.toHaveBeenCalled();
    await expect(runtime.promoteCandidate(test.run, effect)).rejects.toThrow(
      "Sandbox cleanup failed",
    );
    expect(resetClose).toHaveBeenCalledTimes(1);
    expect(duplicateClose).not.toHaveBeenCalled();
    await expect(runtime.promoteCandidate(test.run, effect)).rejects.toThrow(
      "Sandbox cleanup failed",
    );
    expect(resetClose).toHaveBeenCalledTimes(2);
    expect(duplicateClose).toHaveBeenCalledTimes(1);
    await expect(
      runtime.promoteCandidate(test.run, effect),
    ).resolves.toBeUndefined();
    expect(resetClose).toHaveBeenCalledTimes(2);
    expect(duplicateClose).toHaveBeenCalledTimes(2);
    expect(messages.join(" ")).not.toContain("secret");
  });

  it("retains a failed verification close for a later cleanup retry", async () => {
    const test = context();
    const messages: string[] = [];
    const verificationClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValue(undefined);
    let allocations = 0;
    const runtime = await createLocalPasswordResetEffects(test, {
      createProvider: (id) => ({
        id,
        allocate: async (request) => {
          allocations += 1;
          return {
            provider: "wasm-relay",
            session: request.session ?? "",
            browser: driver(false, "bad"),
            allowedDomains: [],
            close: allocations === 1 ? async () => {} : verificationClose,
          };
        },
      }),
      notify: (message) => messages.push(message),
    });
    expect(await runtime.verifyCandidate(test.run, effect)).toBe("unknown");
    expect(messages.join(" ")).toContain("Sandbox cleanup failed");
    expect(messages.join(" ")).not.toContain("private detail");
    await expect(
      runtime.promoteCandidate(test.run, effect),
    ).resolves.toBeUndefined();
    expect(verificationClose).toHaveBeenCalledTimes(2);
  });
});
