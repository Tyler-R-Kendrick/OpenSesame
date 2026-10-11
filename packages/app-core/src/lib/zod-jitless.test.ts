/**
 * The boot seeds zod's shared configuration before any schema loads
 * (`zod-jitless.ts`). This holds the installed zod to the two things that
 * relies on: it adopts the object on `globalThis`, and with `jitless` set it
 * never asks whether eval is allowed, which under the app's CSP is a reported
 * violation.
 */
import { describe, expect, it } from "vitest";
import { zodJitless } from "./zod-jitless.js";

describe("zod under a CSP that forbids eval", () => {
  it("is jitless once the boot has seeded it, and never asks for eval", async () => {
    zodJitless();
    const { config, util } = await import("zod/v4/core");
    expect(config().jitless).toBe(true);
    // Node itself allows eval, so false here can only be zod not asking.
    expect(util.allowsEval.value).toBe(false);
    const { z } = await import("zod");
    expect(z.object({ a: z.string() }).parse({ a: "b" })).toEqual({ a: "b" });
  });

  it("keeps what is already there, and holds when set after zod loaded", () => {
    const adopted = { jitless: false, customError: "kept" };
    const scope = { __zod_globalConfig: adopted };
    zodJitless(scope);
    expect(scope.__zod_globalConfig).toBe(adopted);
    expect(adopted).toEqual({ jitless: true, customError: "kept" });
  });
});
