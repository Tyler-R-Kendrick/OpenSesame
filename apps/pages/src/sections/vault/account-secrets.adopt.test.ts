import {
  type LoginMethod,
  createCredential,
  createItem,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { splitAdopted } from "./account-secrets.js";

const key: LoginMethod = {
  id: "k9",
  type: "api-key",
  key: "ak_9",
  header: "X-Api-Key",
};

describe("splitAdopted", () => {
  const account = createItem("account", "Billing");

  it("takes a credential kept on its own out of the account and binds it", () => {
    const spare = createCredential(key, "Spare", null);
    const edited: LoginMethod = { ...key, key: "ak_edited" };
    const split = splitAdopted([account, spare], {
      ...account,
      methods: [...account.methods, edited],
    });
    expect(split.account.methods.map((method) => method.id)).toEqual(
      account.methods.map((method) => method.id),
    );
    expect(split.adopted).toHaveLength(1);
    expect(split.adopted[0]).toMatchObject({
      id: "k9",
      accountId: account.id,
      method: { key: "ak_edited" },
    });
  });

  it("leaves a method that is the account's own, or new, alone", () => {
    const bound = createCredential(key, "Mine", account.id);
    const fresh: LoginMethod = { ...key, id: "k10" };
    const split = splitAdopted([account, bound], {
      ...account,
      methods: [...account.methods, key, fresh],
    });
    expect(split.adopted).toEqual([]);
    expect(split.account.methods.map((method) => method.id)).toContain("k9");
    expect(split.account.methods.map((method) => method.id)).toContain("k10");
  });

  it("does not take a trashed credential", () => {
    const gone = {
      ...createCredential(key, "Gone", null),
      deletedAt: "2026-01-01T00:00:00.000Z",
    };
    const split = splitAdopted([account, gone], {
      ...account,
      methods: [...account.methods, key],
    });
    expect(split.adopted).toEqual([]);
  });
});
