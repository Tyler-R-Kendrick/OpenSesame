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

describe("run-scoped pepper custody", () => {
  it("authorizes before production and asks once per run", async () => {
    const source = vi.fn(async () => method);
    const pepper = vi.fn(async () => "PERSON_PEPPER");
    const custody = new CandidateCustody(source, pepper);
    const first = await custody.withPassword(async (password) => password);
    expect(first.endsWith("PERSON_PEPPER")).toBe(true);
    expect(await custody.withPassword(async (password) => password)).toBe(first);
    expect(source).toHaveBeenCalledTimes(2);
    expect(pepper).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(custody)).not.toContain(first);
    custody.forget();
    await custody.withPassword(async () => undefined);
    expect(pepper).toHaveBeenCalledTimes(2);
  });

  it("uses a random same-shape synthetic only inside the proxy closure", async () => {
    const custody = new CandidateCustody(method, () => "PERSON_PEPPER");
    const real = await custody.withPassword(async (password) => password);
    const synthetic = await custody.withSynthetic(proof, async (value) => value);
    expect(synthetic).toHaveLength(real.length);
    expect(synthetic).not.toBe(real);
    expect([...synthetic].every((character, index) =>
      /[a-z]/u.test(real[index] ?? "") ? /[a-z]/u.test(character) : true)).toBe(true);
    expect(() => assertProxyLane(true, undefined)).toThrow("requires");
    expect(() => assertProxyLane(true, { ...proof, canaryVerified: false } as never)).toThrow();
  });

  it("refuses manual and unslotted methods before asking for pepper", async () => {
    const pepper = vi.fn(async () => "PERSON_PEPPER");
    const manual: PasswordMethod = {
      id: "manual-1",
      type: "password",
      generator: { id: "manual" },
      secret: "stored-candidate",
      pepper: false,
      changedAt: "2026-10-27T00:00:00.000Z",
    };
    await expect(new CandidateCustody(manual, pepper)
      .withPassword(async (value) => value)).rejects.toThrow("algorithmic");
    await expect(new CandidateCustody({ ...method, pepper: false }, pepper)
      .withPassword(async () => undefined)).rejects.toThrow("pepper slot");
    expect(pepper).not.toHaveBeenCalled();
  });
});
