import type { PasswordMethod } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { CandidateCustody, assertProxyLane } from "./secrets.js";
import type { ProxyProof } from "./types.js";

const method: PasswordMethod = {
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
  changedAt: "2026-10-27T00:00:00.000Z",
};

const proof: ProxyProof = {
  origin: "https://accounts.example.test",
  method: "POST",
  path: "/reset",
  field: "password",
  contentType: "application/x-www-form-urlencoded",
  identityEncoding: true,
  untransformedForm: true,
  canaryVerified: true,
};

describe("candidate custody", () => {
  it("uses slotted algorithmic output and asks the person for pepper once per run", async () => {
    const calls: string[] = [];
    const source = vi.fn(async () => method);
    const pepper = vi.fn(async () => "human-pepper");
    const custody = new CandidateCustody(source, pepper, () => {
      calls.push("grant");
    });
    const first = await custody.withPassword(async (password) => password);
    const second = await custody.withPassword(async (password) => password);
    expect(first).toBe(second);
    expect(first.endsWith("human-pepper")).toBe(true);
    expect(source).toHaveBeenCalledTimes(2);
    expect(pepper).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("grant");
    expect(JSON.stringify(custody)).not.toContain("human-pepper");
    custody.forget();
    await custody.withPassword(async () => undefined);
    expect(pepper).toHaveBeenCalledTimes(2);
  });

  it("refuses manual output and an empty or missing pepper", async () => {
    const manual: PasswordMethod = {
      id: "manual-1",
      type: "password",
      generator: { id: "manual" },
      secret: "stored-candidate",
      pepper: false,
      changedAt: "2026-10-27T00:00:00.000Z",
    };
    await expect(
      new CandidateCustody(manual, async () => "pepper").withPassword(
        async (value) => value,
      ),
    ).rejects.toThrow("algorithmic");
    await expect(
      new CandidateCustody(method, async () => "").withPassword(
        async () => undefined,
      ),
    ).rejects.toThrow("supply the pepper");
  });

  it("makes a random same-shape synthetic only inside a strict proxy closure", async () => {
    const custody = new CandidateCustody(method, async () => "human-pepper");
    const real = await custody.withPassword(async (password) => password);
    const synthetic = await custody.withSynthetic(
      proof,
      async (value) => value,
    );
    expect(synthetic).toHaveLength(real.length);
    expect(synthetic).not.toBe(real);
    expect(
      [...synthetic].every((character, index) =>
        /[a-z]/u.test(real[index] ?? "") ? /[a-z]/u.test(character) : true,
      ),
    ).toBe(true);
    // Symbol characters of the real candidate (pepper included) must not
    // pass through verbatim at their positions.
    const symbolCustody = new CandidateCustody(method, async () => "!@#$%^&*");
    const symbolReal = await symbolCustody.withPassword(
      async (password) => password,
    );
    const symbolSynthetic = await symbolCustody.withSynthetic(
      proof,
      async (value) => value,
    );
    expect(symbolSynthetic).not.toContain("!@#$%^&*");
    expect(
      [...symbolSynthetic].some(
        (character, index) =>
          /[^a-zA-Z0-9]/u.test(symbolReal[index] ?? "") &&
          character !== symbolReal[index],
      ),
    ).toBe(true);
    expect(() => assertProxyLane(true, undefined)).toThrow("requires");
    expect(() => assertProxyLane(true, proof)).not.toThrow();
    // SAFETY: the deliberately invalid proof must reach the schema to prove rejection.
    expect(() =>
      assertProxyLane(true, { ...proof, canaryVerified: false } as never),
    ).toThrow();
  });
});
