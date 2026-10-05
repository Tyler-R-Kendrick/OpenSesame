import {
  type AccountItem,
  type PasswordMethod,
  type PepperSeal,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  NeedsPepperError,
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

describe("an account's password at the terminal", () => {
  it("copies a plain password and keeps every other method", () => {
    const item = withPassword(account(), "plain-pw");
    expect(secretText(item)).toBe("plain-pw");
    expect(item.methods.map((m) => m.type)).toEqual([
      "password",
      "authenticator",
      "token",
    ]);
  });

  it("treats a peppered password as absent: refuses, never copies the sealed form", () => {
    const item = account({ pepper: true, secret: "", sealed: SEALED });
    expect(() => secretText(item)).toThrow(NeedsPepperError);
    expect(() => withPassword(item, "new")).toThrow(/needs_pepper/);
  });

  it("treats a Sphinx password as absent", () => {
    const item = account({
      pepper: true,
      secret: "",
      generator: {
        id: "sphinx",
        rules: {
          length: 20,
          lower: true,
          upper: true,
          digits: true,
          symbols: true,
          avoidAmbiguous: false,
          minDigits: 0,
          minSymbols: 0,
        },
        realm: "example.com",
        counter: 0,
        oprfKeyB64: "a2V5",
      },
    });
    expect(() => secretText(item)).toThrow(NeedsPepperError);
  });

  it("adds a manual password to an account that has none", () => {
    const base = createItem("account", "Keys");
    const bare: AccountItem = { ...base, methods: [] };
    expect(passwordMethod(withPassword(bare, "pw"))?.secret).toBe("pw");
  });

  it("carries no pepper or envelope in its refusal", () => {
    const item = account({ pepper: true, secret: "", sealed: SEALED });
    try {
      secretText(item);
    } catch (error) {
      expect(String(error)).not.toContain("c2VhbGVk");
    }
  });
});
