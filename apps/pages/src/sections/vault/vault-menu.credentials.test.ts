import {
  type AccountItem,
  type LoginMethod,
  createCredential,
  manualPassword,
} from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../../components/context-menu/menu-model.js";
import { credentialChoices } from "./account-credentials.js";
import { makeAccount } from "./account.test-support.js";
import { type VaultTreeActions, vaultItemMenu } from "./vault-menu.js";

const apiKey = (key = "ak_1", id = "k"): LoginMethod => ({
  id,
  type: "api-key",
  key,
  header: "X-Api-Key",
});
const token = (value = "tok_1", id = "t"): LoginMethod => ({
  id,
  type: "token",
  token: value,
  expiresAt: "",
});
const oauth: LoginMethod = {
  id: "o",
  type: "oauth",
  clientId: "cid",
  clientSecret: "csecret",
  tokenUrl: "",
  scopes: "",
  refreshToken: "rtok",
};

function account(methods: LoginMethod[], keepPassword = true): AccountItem {
  const base = makeAccount({ id: "itm_m", password: "pw-1" });
  return {
    ...base,
    methods: keepPassword ? [...base.methods, ...methods] : methods,
  };
}

function actions(): VaultTreeActions {
  return {
    open: vi.fn(),
    preview: vi.fn(),
    copySecret: vi.fn(),
    copyCredential: vi.fn(),
    copyUsername: vi.fn(),
    edit: vi.fn(),
    trash: vi.fn(),
    favorite: vi.fn(),
    share: vi.fn(),
    shareGrant: vi.fn(),
    create: vi.fn(),
  };
}

const copyGroup = (item: AccountItem, a = actions()): readonly MenuItem[] => {
  const group = vaultItemMenu(item, a)[1];
  if (!group) throw new Error("no copy group");
  return group;
};

describe("an account's copy menu asks which credential", () => {
  it("is one row named for it when the account holds a single credential", () => {
    const [copy, username] = copyGroup(account([]));
    expect(copy?.label).toBe("Copy password");
    expect(copy?.hint).toBe("y");
    expect(copy?.submenu).toBeUndefined();
    expect(username?.label).toBe("Copy username");
  });

  it("is a submenu of every credential when there are several, never `Copy secret`", () => {
    const a = actions();
    const [copy] = copyGroup(account([apiKey(), token(), oauth]), a);
    expect(copy?.label).toBe("Copy");
    expect(copy?.disabled).toBeUndefined();
    const labels = copy?.submenu?.[0]?.map((entry) => entry.label);
    expect(labels).toEqual([
      "Password",
      "API key",
      "API key as header",
      "Token",
      "Token as bearer",
      "OAuth client secret",
      "OAuth refresh token",
    ]);
    expect(
      vaultItemMenu(account([apiKey(), token()]), a)
        .flat()
        .some((entry) => entry.label === "Copy secret"),
    ).toBe(false);
  });

  it("shows the y key on the credential y copies, and runs the one chosen", () => {
    const a = actions();
    const item = account([apiKey()]);
    const entries = copyGroup(item, a)[0]?.submenu?.[0] ?? [];
    expect(entries.filter((entry) => entry.hint === "y")).toHaveLength(1);
    expect(entries.find((entry) => entry.hint === "y")?.label).toBe("Password");
    entries.find((entry) => entry.label === "API key as header")?.run();
    expect(a.copyCredential).toHaveBeenCalledWith(item, "k:line");
  });

  it("puts y on the API key's line when there is no password, ahead of a token", () => {
    const item = account([token(), apiKey()], false);
    const entries = copyGroup(item)[0]?.submenu?.[0] ?? [];
    expect(entries.find((entry) => entry.hint === "y")?.label).toBe(
      "API key as header",
    );
  });

  it("numbers credentials of one kind, and gives each its own id", () => {
    const item = account([apiKey("a", "k1"), apiKey("b", "k2")], false);
    const choices = credentialChoices(item);
    expect(choices.map((choice) => choice.label)).toEqual([
      "API key 1",
      "API key 1 as header",
      "API key 2",
      "API key 2 as header",
    ]);
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(4);
  });

  it("is a disabled `Copy` when there is nothing to copy, with the username still its own row", () => {
    const item = account([apiKey(""), token("")], false);
    const [copy, username] = copyGroup(item);
    expect(copy).toMatchObject({ label: "Copy", disabled: true });
    expect(username?.label).toBe("Copy username");
  });
});

describe("what each credential puts on the clipboard", () => {
  const read = async (item: AccountItem, id: string) =>
    credentialChoices(item)
      .find((choice) => choice.id === id)
      ?.read();

  it("gives each value alone, and each line whole", async () => {
    const item = account([apiKey(), token(), oauth], false);
    expect(await read(item, "k:key")).toBe("ak_1");
    expect(await read(item, "k:line")).toBe("X-Api-Key: ak_1");
    expect(await read(item, "t:token")).toBe("tok_1");
    expect(await read(item, "t:line")).toBe("Authorization: Bearer tok_1");
    expect(await read(item, "o:secret")).toBe("csecret");
    expect(await read(item, "o:refresh")).toBe("rtok");
  });

  it("gives a password's start and its rest when the pepper goes inside it", async () => {
    const base = makeAccount({ id: "itm_p", password: "abcdefghij" });
    const [method] = base.methods;
    if (method?.type !== "password") throw new Error("fixture");
    const slotted: AccountItem = {
      ...base,
      methods: [{ ...method, pepper: true, pepperAt: "-4" }],
    };
    const choices = credentialChoices(slotted);
    expect(choices.map((choice) => choice.label)).toEqual([
      "Password",
      "Rest of password",
    ]);
    expect(await choices[0]?.read()).toBe("abcdef");
    expect(await choices[1]?.read()).toBe("ghij");
  });

  it("gives the current authenticator code", async () => {
    const item = account(
      [{ id: "a", type: "authenticator", secret: "JBSWY3DPEHPK3PXP" }],
      false,
    );
    expect(await read(item, "a:code")).toMatch(/^\d{6}$/);
  });

  it("offers nothing for an empty or whitespace value", () => {
    expect(
      credentialChoices(account([apiKey("  "), token(""), oauth], false)).map(
        (choice) => choice.id,
      ),
    ).toEqual(["o:secret", "o:refresh"]);
  });
});

describe("a credential kept on its own copies as the one it is (ADR 0177)", () => {
  const own = (method: LoginMethod) => createCredential(method, "Spare");

  it("is one row named for it, with no username", () => {
    const group = vaultItemMenu(own(apiKey("ak_1")), actions())[1] ?? [];
    expect(group.map((row) => row.label)).toEqual(["Copy"]);
    const labels = group[0]?.submenu?.[0]?.map((entry) => entry.label);
    expect(labels).toEqual(["API key", "API key as header"]);
  });

  it("names a password as itself", () => {
    const [copy, ...rest] =
      vaultItemMenu(
        own(manualPassword("p", "pw", "2026-01-01T00:00:00.000Z")),
        actions(),
      )[1] ?? [];
    expect(copy?.label).toBe("Copy password");
    expect(copy?.hint).toBe("y");
    expect(rest).toEqual([]);
  });

  it("keeps a row visible and disabled when there is nothing to copy", () => {
    const [copy] = vaultItemMenu(own(apiKey("")), actions())[1] ?? [];
    expect(copy?.disabled).toBe(true);
  });
});
