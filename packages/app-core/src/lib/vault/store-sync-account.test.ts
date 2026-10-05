/**
 * An account crosses the sealed-store bridge whole (ADR 0168): every method,
 * the pepper seal and the Sphinx key untouched, a login written before the
 * account read as the same account every time, and a hostile manifest unable
 * to put anything on an item but a whole method.
 */
import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import {
  type AccountItem,
  type LoginMethod,
  accountPlainPassword,
  createItem,
  methodsOfType,
  normalizeLegacyItems,
  passwordMethod,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  entryToVaultItem,
  planManifestMerge,
  vaultItemToEntry,
} from "./store-sync.js";

const SPHINX_KEY = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const RULES = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
  minDigits: 0,
  minSymbols: 0,
};

function accountOf(item: ReturnType<typeof entryToVaultItem>): AccountItem {
  if (item.kind !== "account") throw new Error("expected an account");
  return item;
}

async function richAccount() {
  const item = createItem("account", "Rich");
  item.username = "ada";
  const sealed = await sealWithPepper(
    "peppered-pw",
    "the pepper",
    pepperBinding(item.id, "m:peppered"),
  );
  const methods: LoginMethod[] = [
    {
      id: "m:peppered",
      type: "password",
      generator: { id: "rules", ...RULES },
      pepper: true,
      secret: "",
      sealed,
      changedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m:sphinx",
      type: "password",
      generator: {
        id: "sphinx",
        rules: RULES,
        realm: "example.com",
        counter: 2,
        oprfKeyB64: SPHINX_KEY,
      },
      pepper: true,
      secret: "",
      changedAt: "2026-01-01T00:00:00.000Z",
    },
    { id: "m:key", type: "api-key", key: "sk_live_abc", header: "X-Api-Key" },
    { id: "m:token", type: "token", token: "tok_123", expiresAt: "" },
    {
      id: "m:oauth",
      type: "oauth",
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://example.com/token",
      scopes: "read write",
      refreshToken: "rtok",
    },
    { id: "m:totp", type: "authenticator", secret: "JBSWY3DPEHPK3PXP" },
  ];
  item.methods = methods;
  return { item, sealed };
}

describe("an account through a store entry", () => {
  it("round-trips every method, the pepper seal and the Sphinx key unchanged", async () => {
    const { item, sealed } = await richAccount();
    const entry = vaultItemToEntry(item, []);
    // Nothing is in the clear on line one: the first password is peppered.
    expect(entry.secret).toBe("");
    const back = accountOf(entryToVaultItem(entry));
    expect(back.methods).toEqual(item.methods);
    expect(passwordMethod(back)?.sealed).toEqual(sealed);
    expect(JSON.stringify(passwordMethod(back)?.sealed)).toBe(
      JSON.stringify(sealed),
    );
    const sphinx = methodsOfType(back, "password")[1];
    expect(sphinx?.generator).toMatchObject({ oprfKeyB64: SPHINX_KEY });
    // Encoding what was decoded gives the same entry: a re-import is a no-op.
    expect(vaultItemToEntry(back, [])).toEqual(entry);
  });

  it("keeps a plain password on line one once, never in the trailer", () => {
    const item = createItem("account", "Plain");
    const method = passwordMethod(item);
    if (method) method.secret = "hunter2";
    const entry = vaultItemToEntry(item, []);
    expect(entry.secret).toBe("hunter2");
    expect(entry.trailer).not.toContain("hunter2");
    expect(accountPlainPassword(accountOf(entryToVaultItem(entry)))).toBe(
      "hunter2",
    );
  });

  it("carries a password with a line break in the trailer, line one empty", () => {
    const item = createItem("account", "Long");
    const method = passwordMethod(item);
    if (method) method.secret = "first\nsecond";
    const entry = vaultItemToEntry(item, []);
    expect(entry.secret).toBe("");
    expect(accountPlainPassword(accountOf(entryToVaultItem(entry)))).toBe(
      "first\nsecond",
    );
  });

  it("does not put a peppered password on line one when line one is edited", async () => {
    const { item } = await richAccount();
    const entry = { ...vaultItemToEntry(item, []), secret: "typed-in-pass" };
    const back = accountOf(entryToVaultItem(entry));
    expect(passwordMethod(back)?.secret).toBe("");
  });

  it("is a no-op to import the same manifest twice", async () => {
    const { item } = await richAccount();
    const entry = vaultItemToEntry(item, []);
    const plan = planManifestMerge([entry], [item], []);
    expect(plan.unchanged).toBe(1);
    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
  });

  it("keeps the rotation fields an account carries", () => {
    const item = createItem("account", "Rotated");
    item.resetEmailId = "email-1";
    item.supersededById = "next";
    item.retiredAt = "2026-02-01T00:00:00.000Z";
    item.reenrollState = "old-retired";
    const back = accountOf(entryToVaultItem(vaultItemToEntry(item, [])));
    expect(back).toMatchObject({
      resetEmailId: "email-1",
      supersededById: "next",
      retiredAt: "2026-02-01T00:00:00.000Z",
      reenrollState: "old-retired",
    });
  });
});

describe("entries written before the account", () => {
  const legacyTrailer = (extra: JsonObject) =>
    JSON.stringify({ kind: "login", v: 2, username: "ada", ...extra });

  it("reads a login entry as the account migration would make it", () => {
    const back = accountOf(
      entryToVaultItem({
        path: "mail",
        secret: "hunter2",
        trailer: legacyTrailer({
          totp: "JBSWY3DPEHPK3PXP",
          uris: ["https://mail.example.com"],
          values: { passwordChangedAt: "2026-01-15T00:00:00.000Z" },
        }),
      }),
    );
    expect(back.methods).toEqual([
      expect.objectContaining({
        id: `${back.id}:password`,
        secret: "hunter2",
        changedAt: "2026-01-15T00:00:00.000Z",
        generator: { id: "manual" },
      }),
      {
        id: `${back.id}:authenticator`,
        type: "authenticator",
        secret: "JBSWY3DPEHPK3PXP",
      },
    ]);
    expect(back.uris.map((u) => u.uri)).toEqual(["https://mail.example.com"]);
  });

  it("reads a long login password from values", () => {
    const back = accountOf(
      entryToVaultItem({
        path: "mail",
        secret: "",
        trailer: legacyTrailer({ values: { password: "a\nb" } }),
      }),
    );
    expect(accountPlainPassword(back)).toBe("a\nb");
  });

  it("is stable: a login entry migrates once and re-encodes as an account", () => {
    const first = accountOf(
      entryToVaultItem({ path: "x", secret: "pw", trailer: "" }),
    );
    expect(normalizeLegacyItems([first])[0]).toBe(first);
    const entry = vaultItemToEntry(first, []);
    expect(JSON.parse(entry.trailer)).toMatchObject({ kind: "account", v: 2 });
    expect(JSON.stringify(entry)).not.toContain('"kind":"login"');
  });

  it("grafts a first-format entry onto an account without touching its other methods", async () => {
    const { item } = await richAccount();
    const target = createItem("account", "Plain");
    const plainId = `${target.id}:pw`;
    target.methods = [
      {
        id: plainId,
        type: "password",
        generator: { id: "manual" },
        pepper: false,
        secret: "old",
        changedAt: "2026-01-01T00:00:00.000Z",
      },
      ...item.methods,
    ];
    const plan = planManifestMerge(
      [
        {
          path: "Plain",
          secret: "from-old-manifest",
          trailer: JSON.stringify({ kind: "login" }),
        },
      ],
      [target],
      [],
    );
    const updated = plan.updates[0];
    if (updated?.kind !== "account") throw new Error("expected an account");
    expect(updated.methods.map((m) => m.id)).toEqual(
      target.methods.map((m) => m.id),
    );
    expect(updated.methods[0]).toMatchObject({
      id: plainId,
      secret: "from-old-manifest",
    });
    expect(updated.methods.slice(1)).toEqual(target.methods.slice(1));
  });

  it("never lets a first-format line replace a password kept behind a pepper", async () => {
    const { item } = await richAccount();
    const plan = planManifestMerge(
      [
        {
          path: "Rich",
          secret: "from-old-manifest",
          trailer: JSON.stringify({ kind: "login", username: "ada" }),
        },
      ],
      [item],
      [],
    );
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });
});

describe("a hostile manifest", () => {
  const entry = (methods: JsonValue) => ({
    path: "x",
    secret: "",
    trailer: JSON.stringify({ kind: "account", v: 2, values: { methods } }),
  });

  it("keeps only whole methods, rebuilt from the fields their type names", () => {
    const back = accountOf(
      entryToVaultItem(
        entry([
          { id: "k", type: "api-key", key: "kk", header: "H", evil: "x" },
          { id: "bad", type: "api-key", key: 7, header: "H" },
          { id: "k", type: "token", token: "dup", expiresAt: "" },
          { type: "token", token: "no id", expiresAt: "" },
          { id: "z", type: "unknown" },
          "nonsense",
        ]),
      ),
    );
    expect(back.methods).toEqual([
      { id: "k", type: "api-key", key: "kk", header: "H" },
    ]);
  });

  it("drops a Sphinx method with no key and types a garbled generator manual", () => {
    const back = accountOf(
      entryToVaultItem(
        entry([
          {
            id: "s",
            type: "password",
            generator: { id: "sphinx", realm: "r" },
            pepper: true,
            secret: "",
            changedAt: "t",
          },
          {
            id: "r",
            type: "password",
            generator: { id: "rules", length: "long" },
            pepper: false,
            secret: "kept",
            changedAt: "t",
          },
        ]),
      ),
    );
    expect(back.methods).toHaveLength(1);
    expect(passwordMethod(back)?.generator).toEqual({ id: "manual" });
    expect(passwordMethod(back)?.secret).toBe("kept");
  });

  it("refuses a pepper seal that is not whole", () => {
    const back = accountOf(
      entryToVaultItem(
        entry([
          {
            id: "p",
            type: "password",
            generator: { id: "manual" },
            pepper: true,
            secret: "",
            sealed: { v: 1, kdf: { alg: "MD5" }, seal: {} },
            changedAt: "t",
          },
        ]),
      ),
    );
    expect(back.methods).toEqual([]);
  });

  it("reads an account entry with no method list as the login it describes", () => {
    const back = accountOf(
      entryToVaultItem({
        path: "x",
        secret: "pw",
        trailer: JSON.stringify({ kind: "account", username: "u" }),
      }),
    );
    expect(accountPlainPassword(back)).toBe("pw");
    expect(back.username).toBe("u");
  });
});
