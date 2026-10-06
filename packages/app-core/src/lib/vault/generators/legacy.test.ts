import {
  DEFAULT_RULES,
  type PasswordMethod,
  WrongPepperError,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { convertLegacyMethod, isLegacyMethod } from "./legacy.js";
import { mintOprfKey, sphinxPassword, vaultEvaluator } from "./sphinx.js";

const ACCOUNT = { id: "itm_a", username: "ada" };
type Generator = PasswordMethod["generator"];
type Sphinx = Extract<Generator, { id: "sphinx" }>;

function method(
  generator: Generator,
  rest: Partial<PasswordMethod> = {},
): PasswordMethod {
  return {
    id: "m1",
    type: "password",
    generator,
    pepper: false,
    secret: "",
    changedAt: "2026-10-01T00:00:00.000Z",
    ...rest,
  };
}

function sphinx(counter: number, realm: string): Sphinx {
  return {
    id: "sphinx",
    realm,
    counter,
    oprfKeyB64: mintOprfKey(),
    rules: { ...DEFAULT_RULES },
  };
}

async function sealed(pepper: string, bindTo = "m1"): Promise<PasswordMethod> {
  return method(
    { id: "manual" },
    {
      pepper: true,
      sealed: await sealWithPepper(
        "correct-horse",
        pepper,
        pepperBinding(ACCOUNT.id, bindTo),
      ),
    },
  );
}

describe("what an older version made is legacy, and nothing else is", () => {
  it("is a seal, or a Sphinx key", async () => {
    expect(isLegacyMethod(await sealed("p"))).toBe(true);
    expect(isLegacyMethod(method(sphinx(1, "r")))).toBe(true);
  });

  it("is not a stored, slotted or algorithmic password", () => {
    const stored = method({ id: "manual" }, { secret: "x" });
    const slotted = method(
      { id: "manual" },
      { secret: "x", pepper: true, pepperAt: "3" },
    );
    const algorithmic = method(
      { id: "derived", rules: { ...DEFAULT_RULES }, counter: 0 },
      { secret: "root" },
    );
    for (const each of [stored, slotted, algorithmic]) {
      expect(isLegacyMethod(each)).toBe(false);
    }
  });
});

describe("converting once", () => {
  const now = new Date("2026-10-06T00:00:00Z");

  it("opens a sealed password with the earlier pepper and keeps no seal", async () => {
    const out = await convertLegacyMethod(
      ACCOUNT,
      await sealed("right"),
      "right",
      now,
    );
    expect(out).toEqual({
      id: "m1",
      type: "password",
      generator: { id: "manual" },
      pepper: false,
      secret: "correct-horse",
      changedAt: now.toISOString(),
    });
    expect(JSON.stringify(out)).not.toContain("right");
  });

  it("refuses a wrong pepper, an empty one, and a seal bound to another method", async () => {
    await expect(
      convertLegacyMethod(ACCOUNT, await sealed("right"), "wrong"),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      convertLegacyMethod(ACCOUNT, await sealed("right"), ""),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      convertLegacyMethod(ACCOUNT, await sealed("right", "other"), "right"),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("refuses a method with no seal and no Sphinx key, whatever it is given", async () => {
    await expect(
      convertLegacyMethod(
        ACCOUNT,
        method({ id: "manual" }, { secret: "x" }),
        "anything",
      ),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("computes a Sphinx password from its master input and keeps none of it", async () => {
    const generator = sphinx(2, "example.test");
    const out = await convertLegacyMethod(
      ACCOUNT,
      method(generator),
      "one master",
      now,
    );
    const expected = await sphinxPassword(
      {
        master: "one master",
        realm: generator.realm,
        username: ACCOUNT.username,
        counter: generator.counter,
        rules: generator.rules,
      },
      vaultEvaluator(generator.oprfKeyB64),
    );
    expect(out).toMatchObject({
      generator: { id: "manual" },
      pepper: false,
      secret: expected,
    });
    expect(JSON.stringify(out)).not.toContain("one master");
    expect(JSON.stringify(out)).not.toContain(generator.oprfKeyB64);
  });
});
