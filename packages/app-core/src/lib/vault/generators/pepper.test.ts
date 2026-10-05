import {
  DEFAULT_RULES,
  type PasswordMethod,
  WrongPepperError,
} from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import {
  checkPepper,
  disablePepper,
  enablePepper,
  storePassword,
  usePassword,
} from "./pepper.js";
import { defaultGenerator } from "./registry.js";
import type { OprfEvaluator } from "./sphinx.js";
import { vaultEvaluator } from "./sphinx.js";

const ACCOUNT = { id: "acct-1", username: "ada@example.com" };
const PEPPER = "pepper-7f3a-never-in-errors";
const MASTER = "master-9b21-never-in-errors";
const PASSWORD = "S3cret-value-xyz";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const manual = (over: Partial<PasswordMethod> = {}): PasswordMethod => ({
  id: "acct-1:password",
  type: "password",
  generator: { id: "manual" },
  pepper: false,
  secret: "",
  changedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const sphinx = (): PasswordMethod => ({
  ...manual({ id: "acct-1:sphinx", pepper: true }),
  generator: defaultGenerator("sphinx", { realm: "example.com" }),
});

/** The message a failing call threw, or a marker when it did not throw. */
async function failure(run: () => Promise<string>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "did not throw";
}

const asking = (answer: string) => vi.fn(async () => answer);

async function sealed(): Promise<PasswordMethod> {
  return storePassword(
    ACCOUNT.id,
    manual({ pepper: true }),
    PASSWORD,
    PEPPER,
    NOW,
  );
}

describe("storePassword", () => {
  it("keeps a plain password in secret and stamps changedAt", async () => {
    const out = await storePassword(ACCOUNT.id, manual(), PASSWORD, null, NOW);
    expect(out.secret).toBe(PASSWORD);
    expect(out.sealed).toBeUndefined();
    expect(out.changedAt).toBe(NOW.toISOString());
  });

  it("drops a stale seal when the pepper flag is off", async () => {
    const stale = await sealed();
    const out = await storePassword(
      ACCOUNT.id,
      { ...stale, pepper: false },
      "new",
      null,
      NOW,
    );
    expect(out.sealed).toBeUndefined();
    expect(out.secret).toBe("new");
  });

  it("seals under the pepper and leaves secret empty", async () => {
    const out = await sealed();
    expect(out.secret).toBe("");
    expect(out.sealed?.v).toBe(2);
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(JSON.stringify(out)).not.toContain(PEPPER);
    expect(out.changedAt).toBe(NOW.toISOString());
  });

  it("needs a pepper when the method has one, and never stores a sphinx password", async () => {
    const peppered = manual({ pepper: true });
    await expect(
      storePassword(ACCOUNT.id, peppered, PASSWORD, null),
    ).rejects.toThrow(/pepper is required/);
    await expect(
      storePassword(ACCOUNT.id, peppered, PASSWORD, ""),
    ).rejects.toThrow(/pepper is required/);
    await expect(
      storePassword(ACCOUNT.id, sphinx(), PASSWORD, PEPPER),
    ).rejects.toThrow(/never stored/);
  });
});

describe("usePassword", () => {
  it("returns a plain password without asking", async () => {
    const ask = asking(PEPPER);
    const method = manual({ secret: PASSWORD });
    expect(await usePassword(ACCOUNT, method, ask)).toBe(PASSWORD);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks exactly once for a sealed password and opens it", async () => {
    const method = await sealed();
    const ask = asking(PEPPER);
    expect(await usePassword(ACCOUNT, method, ask)).toBe(PASSWORD);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a wrong or empty pepper, without naming either", async () => {
    const method = await sealed();
    for (const wrong of ["not-the-pepper-123", ""]) {
      await expect(
        usePassword(ACCOUNT, method, asking(wrong)),
      ).rejects.toBeInstanceOf(WrongPepperError);
      const message = await failure(() =>
        usePassword(ACCOUNT, method, asking(wrong)),
      );
      expect(message).not.toContain(PEPPER);
      expect(message).not.toContain(PASSWORD);
    }
  });

  it("will not open a seal moved to another method or account", async () => {
    const method = await sealed();
    await expect(
      usePassword(ACCOUNT, { ...method, id: "acct-1:other" }, asking(PEPPER)),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      usePassword({ ...ACCOUNT, id: "acct-2" }, method, asking(PEPPER)),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("propagates a cancelled prompt and returns nothing", async () => {
    const method = await sealed();
    const cancelled = new Error("cancelled");
    const ask = vi.fn(async () => {
      throw cancelled;
    });
    await expect(usePassword(ACCOUNT, method, ask)).rejects.toBe(cancelled);
    const evaluate = vi.fn();
    await expect(
      usePassword(ACCOUNT, sphinx(), ask, { evaluate }),
    ).rejects.toBe(cancelled);
    expect(evaluate).not.toHaveBeenCalled();
    expect(method.secret).toBe("");
  });

  it("asks exactly once for the master input of a sphinx password and computes it", async () => {
    const method = sphinx();
    const ask = asking(MASTER);
    const first = await usePassword(ACCOUNT, method, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(DEFAULT_RULES.length);
    expect(await usePassword(ACCOUNT, method, asking(MASTER))).toBe(first);
    expect(await usePassword(ACCOUNT, method, asking(`${MASTER}x`))).not.toBe(
      first,
    );
  });

  it("uses the evaluator it is given, and the account's username", async () => {
    const method = sphinx();
    if (method.generator.id !== "sphinx") throw new Error("expected sphinx");
    const seen: Uint8Array[] = [];
    const real = vaultEvaluator(method.generator.oprfKeyB64);
    const evaluator: OprfEvaluator = {
      async evaluate(blinded) {
        seen.push(blinded);
        return real.evaluate(blinded);
      },
    };
    const viaPort = await usePassword(
      ACCOUNT,
      method,
      asking(MASTER),
      evaluator,
    );
    expect(seen).toHaveLength(1);
    expect(await usePassword(ACCOUNT, method, asking(MASTER))).toBe(viaPort);
    const other = { ...ACCOUNT, username: "grace@example.com" };
    expect(await usePassword(other, method, asking(MASTER))).not.toBe(viaPort);
  });

  it("never puts the master input in an error", async () => {
    const evaluator: OprfEvaluator = {
      evaluate: async () => {
        throw new Error(`oops ${MASTER}`);
      },
    };
    const message = await failure(() =>
      usePassword(ACCOUNT, sphinx(), asking(MASTER), evaluator),
    );
    expect(message).not.toContain(MASTER);
    expect(message).toMatch(/could not be computed/);
  });
});

describe("enablePepper and disablePepper", () => {
  it("round-trips a password through the seal", async () => {
    const plain = manual({ secret: PASSWORD });
    const on = await enablePepper(ACCOUNT.id, plain, PASSWORD, PEPPER);
    expect(on.pepper).toBe(true);
    expect(on.secret).toBe("");
    expect(on.sealed).toBeDefined();
    expect(on.changedAt).toBe(plain.changedAt);
    expect(await usePassword(ACCOUNT, on, asking(PEPPER))).toBe(PASSWORD);

    const off = await disablePepper(ACCOUNT.id, on, PEPPER);
    expect(off.pepper).toBe(false);
    expect(off.secret).toBe(PASSWORD);
    expect(off.sealed).toBeUndefined();
  });

  it("will not turn the pepper off with the wrong one", async () => {
    const on = await sealed();
    await expect(
      disablePepper(ACCOUNT.id, on, "wrong-pepper-value"),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("has nothing to open when no password was ever sealed", async () => {
    const off = await disablePepper(
      ACCOUNT.id,
      manual({ pepper: true }),
      PEPPER,
    );
    expect(off).toMatchObject({ pepper: false, secret: "" });
  });

  it("refuses a pepper on a sphinx method, where it is implied", async () => {
    await expect(
      enablePepper(ACCOUNT.id, sphinx(), "x", PEPPER),
    ).rejects.toThrow(/never stored/);
    await expect(disablePepper(ACCOUNT.id, sphinx(), PEPPER)).rejects.toThrow(
      /never stored/,
    );
  });

  it("refuses an empty pepper", async () => {
    await expect(
      enablePepper(ACCOUNT.id, manual(), PASSWORD, ""),
    ).rejects.toThrow(/pepper/);
  });
});

describe("checkPepper", () => {
  it("says whether a pepper opens the seal", async () => {
    const method = await sealed();
    expect(await checkPepper(ACCOUNT.id, method, PEPPER)).toBe(true);
    expect(await checkPepper(ACCOUNT.id, method, "nope-nope-nope")).toBe(false);
    expect(await checkPepper(ACCOUNT.id, method, "")).toBe(false);
  });

  it("is false when there is no seal to open", async () => {
    expect(
      await checkPepper(ACCOUNT.id, manual({ secret: PASSWORD }), PEPPER),
    ).toBe(false);
  });
});
