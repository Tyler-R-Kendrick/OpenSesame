import type { Observation } from "@opensesame/cua-password-reset";
import { describe, expect, it, vi } from "vitest";
import {
  ORIGIN,
  fakeDriver,
  localContext,
  localSandbox,
} from "./password-reset-local-fixtures.js";
import {
  createLocalPasswordResetEffects,
  resetRecipeHostnames,
} from "./password-reset-local-runtime.js";

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

  it("verifies a custom login path in a separate browser session", async () => {
    const driver = fakeDriver();
    const resetDriver = fakeDriver();
    const verificationSandbox = localSandbox(driver);
    let path = "/signin";
    let submitted = false;
    driver.open = vi.fn(async (url: string) => {
      path = new URL(url).pathname;
    });
    driver.pageUrl = vi.fn(async () => new URL(path, ORIGIN).href);
    driver.snapshot = vi.fn(
      async (): Promise<Observation> => ({
        id: crypto.randomUUID(),
        origin: ORIGIN,
        fields: submitted
          ? [{ ref: "e4", kind: "link", label: "Sign out" }]
          : [
              { ref: "e1", kind: "email", label: "Email" },
              { ref: "e2", kind: "password", label: "Password" },
              { ref: "e3", kind: "button", label: "Sign in" },
              { ref: "e5", kind: "link", label: "Forgot password" },
            ],
      }),
    );
    driver.click = vi.fn(async () => {
      path = "/account";
      submitted = true;
    });
    const context = localContext();
    if (context.run.recipe.verification)
      context.run.recipe.verification.loginPath = "/signin";
    const effects = await createLocalPasswordResetEffects(context, {
      sandbox: localSandbox(resetDriver),
      verificationSandbox,
    });
    expect(
      await effects.verifyCandidate(context.run, { effectId: "v", attempt: 1 }),
    ).toBe("verified");
    expect(resetDriver.open).not.toHaveBeenCalled();
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
