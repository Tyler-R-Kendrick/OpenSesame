import type { AccountItem, LoginMethod } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { accountSecretToCopy, canCopySecret } from "./account-copy.js";
import { makeAccount } from "./account.test-support.js";

function withMethods(methods: LoginMethod[]): AccountItem {
  return { ...makeAccount({ id: "itm_c" }), methods };
}

const apiKey: LoginMethod = {
  id: "k",
  type: "api-key",
  key: "ak_1",
  header: "X-Api-Key",
};
const token: LoginMethod = {
  id: "t",
  type: "token",
  token: "tok_1",
  expiresAt: "",
};

describe("copying an account from the list", () => {
  it("gives the password when it has one, whatever else it holds", () => {
    const account = { ...makeAccount({ id: "itm_c", password: "pw-1" }) };
    const both = { ...account, methods: [...account.methods, apiKey, token] };
    expect(accountSecretToCopy(both)).toBe("pw-1");
    expect(canCopySecret(both)).toBe(true);
  });

  it("gives an API key's header line when there is no password", () => {
    expect(accountSecretToCopy(withMethods([apiKey, token]))).toBe(
      "X-Api-Key: ak_1",
    );
    expect(canCopySecret(withMethods([apiKey]))).toBe(true);
  });

  it("gives a bearer line for a token alone", () => {
    expect(accountSecretToCopy(withMethods([token]))).toBe(
      "Authorization: Bearer tok_1",
    );
  });

  it("gives nothing for an account with no value to paste", () => {
    const empty = withMethods([
      { ...apiKey, key: "" },
      { ...token, token: "" },
    ]);
    expect(accountSecretToCopy(empty)).toBeNull();
    expect(canCopySecret(empty)).toBe(false);
    expect(canCopySecret(withMethods([]))).toBe(false);
  });
});
