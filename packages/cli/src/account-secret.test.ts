import {
  type AccountItem,
  type PasswordMethod,
  type PepperSeal,
  createItem,
  mintRootSecret,
  passwordMethod,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  LegacyPasswordError,
  leavesPepperSlot,
  secretText,
  withPassword,
} from "./account-secret.js";

const SEALED = {
  v: 1,
  kdf: { alg: "PBKDF2-SHA256", saltB64: "c2FsdA==", iterations: 600000 },
  seal: { ivB64: "aXY=", ctB64: "c2VhbGVk" },
} as const satisfies PepperSeal;

function account(over: Partial<PasswordMethod> = {}): AccountItem {
  const item = createItem("account", "Mail");
  const method = passwordMethod(item);
  if (!method) throw new Error("a new account has a password method");
  return {
    ...item,
    methods: [
      { ...method, ...over },
      {
        id: `${item.id}:authenticator`,
        type: "authenticator",
        secret: "JBSWY3DP",
      },
      { id: `${item.id}:token`, type: "token", token: "tok-1", expiresAt: "" },
    ],
  };
}

function stored(over: Partial<PasswordMethod> = {}): AccountItem {
  return account({ generator: { id: "manual" }, secret: "kept-pw", ...over });
}

describe("an account's password at the terminal", () => {
  it("copies a stored password and keeps every other method", () => {
    const item = withPassword(account(), "plain-pw");
    expect(secretText(item)).toBe("plain-pw");
    expect(item.methods.map((m) => m.type)).toEqual([
      "password",
      "authenticator",
      "token",
    ]);
  });

  it("copies a password an algorithm computes, through the facade, without the root", () => {
    const item = account({ secret: mintRootSecret() });
    const text = secretText(item);
    expect(text).toHaveLength(20);
    expect(text).not.toBe(passwordMethod(item)?.secret);
    expect(secretText(item)).toBe(text);
  });

  it("copies what comes before a pepper's slot, then the rest, and never asks for a pepper", () => {
    const item = stored({ secret: "abcdefgh", pepper: true, pepperAt: "-2" });
    expect(leavesPepperSlot(item)).toBe(true);
    expect(secretText(item)).toBe("abcdef");
    expect(secretText(item, "later")).toBe("gh");
    const last = stored({ secret: "abcdefgh", pepper: true });
    expect(secretText(last)).toBe("abcdefgh");
    expect(secretText(last, "later")).toBeNull();
  });

  it("refuses what an older version made from a typed pepper, and says nothing of it", () => {
    const item = account({ pepper: true, secret: "", sealed: SEALED });
    expect(() => secretText(item)).toThrow(LegacyPasswordError);
    try {
      secretText(item);
    } catch (error) {
      expect(String(error)).not.toContain("c2VhbGVk");
    }
  });

  it("types a password over an older sealed one, which needs no pepper", () => {
    const item = account({ pepper: true, secret: "", sealed: SEALED });
    const next = withPassword(item, "new");
    expect(passwordMethod(next)).toMatchObject({
      secret: "new",
      pepper: false,
    });
    expect(passwordMethod(next)?.sealed).toBeUndefined();
  });

  it("keeps where a pepper goes when a password is typed over a stored one", () => {
    const item = stored({ pepper: true, pepperAt: "3" });
    expect(passwordMethod(withPassword(item, "pw"))).toMatchObject({
      pepper: true,
      pepperAt: "3",
      secret: "pw",
    });
  });

  it("adds a manual password to an account that has none", () => {
    const base = createItem("account", "Keys");
    const bare: AccountItem = { ...base, methods: [] };
    expect(passwordMethod(withPassword(bare, "pw"))?.secret).toBe("pw");
  });
});
