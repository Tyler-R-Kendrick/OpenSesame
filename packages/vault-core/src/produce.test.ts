import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  type PasswordMethod,
  manualPassword,
  passwordMethod,
} from "./account.js";
import { deriveCharacters, mintRootSecret } from "./derive.js";
import { createItem } from "./model.js";
import {
  accountFilePassword,
  completePassword,
  filePassword,
  handoff,
  isAlgorithmic,
  produceAccountPassword,
  producePassword,
} from "./produce.js";

const AT = "2026-01-01T00:00:00.000Z";
const ROOT = mintRootSecret();

function derived(extra: Partial<PasswordMethod> = {}): PasswordMethod {
  return {
    id: "m",
    type: "password",
    generator: { id: "derived", rules: { ...DEFAULT_RULES }, counter: 0 },
    pepper: false,
    secret: ROOT,
    changedAt: AT,
    ...extra,
  };
}

describe("producing a password", () => {
  it("gives a stored password as it is kept", () => {
    expect(producePassword(manualPassword("m", "s3cret", AT))).toEqual({
      status: "ok",
      password: "s3cret",
    });
  });

  it("computes a derived password from its root, which is never the password", () => {
    const produced = producePassword(derived());
    expect(produced).toEqual({
      status: "ok",
      password: deriveCharacters(ROOT, 0, DEFAULT_RULES),
    });
    expect(JSON.stringify(produced)).not.toContain(ROOT);
  });

  it("is absent with nothing kept, and with no method at all", () => {
    expect(producePassword(derived({ secret: "" }))).toEqual({
      status: "absent",
    });
    const bare = createItem("account", "A");
    if (bare.kind !== "account") throw new Error("fixture");
    bare.methods = [];
    expect(produceAccountPassword(bare)).toEqual({ status: "absent" });
  });

  it("leaves a slot for a pepper, without being given one", () => {
    const method = manualPassword("m", "abcdefghij", AT);
    expect(producePassword({ ...method, pepper: true, pepperAt: "3" })).toEqual(
      { status: "slotted", head: "abc", tail: "defghij", at: "3" },
    );
    expect(producePassword({ ...method, pepper: true })).toEqual({
      status: "slotted",
      head: "abcdefghij",
      tail: "",
      at: "",
    });
  });

  it("slots a derived password the same way, on the computed one", () => {
    const whole = deriveCharacters(ROOT, 0, DEFAULT_RULES);
    const produced = producePassword(derived({ pepper: true, pepperAt: "-4" }));
    expect(produced.status).toBe("slotted");
    if (produced.status !== "slotted") return;
    expect(`${produced.head}${produced.tail}`).toBe(whole);
    expect(produced.tail).toHaveLength(4);
  });

  it("will not produce what an older version made from a typed pepper or master input", () => {
    const sealed: PasswordMethod = {
      ...manualPassword("m", "", AT),
      pepper: true,
      sealed: {
        v: 2,
        kdf: { alg: "PBKDF2-SHA256", saltB64: "AA==", iterations: 1 },
        seal: { ivB64: "AA==", ctB64: "AA==" },
      },
    };
    expect(producePassword(sealed)).toEqual({ status: "legacy" });
    const sphinx: PasswordMethod = {
      ...derived(),
      generator: {
        id: "sphinx",
        rules: { ...DEFAULT_RULES },
        realm: "x",
        counter: 0,
        oprfKeyB64: "AA==",
      },
      pepper: true,
      secret: "",
    };
    expect(producePassword(sphinx)).toEqual({ status: "legacy" });
  });

  it("offers the whole password, or the two parts around the slot, to a surface", () => {
    const ok = producePassword(manualPassword("m", "abc", AT));
    expect(completePassword(ok)).toBe("abc");
    expect(handoff(ok)).toEqual({ now: "abc", later: "" });
    const slotted = producePassword({
      ...manualPassword("m", "abcdef", AT),
      pepper: true,
      pepperAt: "2",
    });
    expect(completePassword(slotted)).toBeNull();
    expect(handoff(slotted)).toEqual({ now: "ab", later: "cdef" });
    expect(handoff({ status: "absent" })).toBeNull();
    expect(handoff({ status: "legacy" })).toBeNull();
  });
});

describe("what a file holds", () => {
  it("is the stored password, and never one an algorithm computes", () => {
    expect(filePassword(manualPassword("m", "kept", AT))).toBe("kept");
    expect(filePassword(derived())).toBe("");
    expect(isAlgorithmic(derived())).toBe(true);
    expect(isAlgorithmic(manualPassword("m", "x", AT))).toBe(false);
    const item = createItem("account", "A");
    if (item.kind !== "account") throw new Error("fixture");
    expect(accountFilePassword(item)).toBe("");
    item.methods = [manualPassword("m", "kept", AT)];
    expect(passwordMethod(item)).toBeDefined();
    expect(accountFilePassword(item)).toBe("kept");
  });
});
