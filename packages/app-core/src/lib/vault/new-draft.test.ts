import {
  accountTotp,
  createItem,
  installItemType,
  itemTypeRegistry,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { producedPassword, visiblePassword } from "../account.test-support.js";
import {
  acceptsDraftUsername,
  generateDraftLabels,
  isGeneratedDraftName,
  newItemDraft,
  prefillNewDraft,
  readDraftPrefill,
} from "./new-draft.js";

describe("new vault draft defaults", () => {
  it("honors installed public defaults and creates PINs without inventing issued key material", () => {
    const bank = newItemDraft("bank-account");
    if (bank.kind !== "typed") throw new Error("fixture");
    expect(bank.values.pin).toMatch(/^\d{6}$/);
    const definition = itemTypeRegistry().get("database");
    if (!definition) throw new Error("fixture");
    try {
      const installed = installItemType(
        JSON.stringify({
          ...definition,
          metadata: {
            ...definition.metadata,
            id: "defaulted-database",
            publisher: "https://community.test",
          },
          spec: {
            ...definition.spec,
            // Every registered type is its own directory, so a copy needs
            // its own names as well as its own extension.
            title: "Defaulted database",
            plural: "Defaulted databases",
            extension: ".testdb",
            sections: definition.spec.sections.map((section) => ({
              ...section,
              fields: section.fields.map((field) =>
                field.id === "engine"
                  ? { ...field, default: "postgresql" }
                  : field,
              ),
            })),
          },
        }),
      );
      expect(installed).toMatchObject({ ok: true });
      expect(newItemDraft("defaulted-database")).toMatchObject({
        values: { engine: "postgresql" },
      });
    } finally {
      syncInstalledTypes({});
    }
    expect(acceptsDraftUsername("missing")).toBe(false);
    expect(() => generateDraftLabels("missing")).toThrow(
      "Unknown vault item type",
    );
  });
  it("names every installed type without fabricating issued credentials", () => {
    for (const { definition } of itemTypeRegistry().list()) {
      const draft = newItemDraft(definition.metadata.id);
      expect(draft.name).toContain(definition.spec.title);
    }
    expect(newItemDraft("passkey")).toMatchObject({
      credentialIdB64: "",
      publicKeyB64: "",
    });
    expect(newItemDraft("certificate")).toMatchObject({
      commonName: "",
      certificatePem: "",
      privateKeyPem: "",
    });
    expect(newItemDraft("card")).toMatchObject({
      number: "",
      cardholder: "",
      code: "",
    });
  });
  it("generates independent concealed values and aliases, not TOTP seeds", () => {
    const first = newItemDraft("account");
    const second = newItemDraft("account");
    if (first.kind !== "account" || second.kind !== "account")
      throw new Error("fixture");
    expect(visiblePassword(first)).toHaveLength(20);
    expect(visiblePassword(first)).not.toBe(visiblePassword(second));
    expect(first.username).toMatch(/^user_[a-f0-9]+$/);
    expect(first.username).not.toBe(second.username);
    expect(accountTotp(first)).toBe("");
    expect(first.uris).toEqual([
      { id: expect.any(String), uri: "", match: "domain" },
    ]);
    expect(first.uris.some((uri) => uri.uri.includes("*"))).toBe(false);
    expect(first.uris[0]?.id).not.toBe(second.uris[0]?.id);
    expect(createItem("account").uris).toEqual([]);
    const secret = newItemDraft("secret");
    if (secret.kind !== "secret") throw new Error("fixture");
    expect(secret.value).toHaveLength(20);
    expect(secret.connectionRef).toBe("");
  });
  it("generates manifest password fields while preserving imported empty values", () => {
    const draft = newItemDraft("database");
    if (draft.kind !== "typed") throw new Error("fixture");
    expect(draft.values.password).toHaveLength(20);
    expect(draft.values.username).toMatch(/^user_/);
    expect(draft.values.connectionString).toBe("");
    expect(producedPassword(createItem("account"))).toBe("");
    expect(() => newItemDraft("missing-type")).toThrow(
      "Unknown vault item type",
    );
  });
});

describe("isGeneratedDraftName", () => {
  it("recognises the name its own type generated", () => {
    expect(
      isGeneratedDraftName(generateDraftLabels("secret").name, "secret"),
    ).toBe(true);
    expect(
      isGeneratedDraftName(generateDraftLabels("account").name, "account"),
    ).toBe(true);
  });

  it("says no to a name another type generated", () => {
    // The exact case: "New item" opens as an account, the person picks Secret,
    // and the name still named the type they had left.
    expect(
      isGeneratedDraftName(generateDraftLabels("account").name, "secret"),
    ).toBe(false);
  });

  it("says no to any name that is not this type's generated shape", () => {
    expect(isGeneratedDraftName("Login f54fa2ea", "secret")).toBe(false);
    expect(isGeneratedDraftName("", "secret")).toBe(false);
    expect(isGeneratedDraftName("Secret", "secret")).toBe(false);
    expect(isGeneratedDraftName("Secret f54fa2ea extra", "secret")).toBe(false);
    // Hex is lowercase; a person's own capitals are their own.
    expect(isGeneratedDraftName("Secret F54FA2EA", "secret")).toBe(false);
  });

  it("counts a typed name that is exactly the shape as generated", () => {
    // The generated form is what the field starts as, and nothing records
    // whether a person retyped it. Replacing it loses eight characters they
    // chose to write down; keeping a stale type's name in an item nobody named
    // is the worse of the two.
    expect(isGeneratedDraftName("Secret f54fa2ea", "secret")).toBe(true);
  });

  it("says no for a type this device has never heard of", () => {
    expect(isGeneratedDraftName("Secret f54fa2ea", "not-installed")).toBe(
      false,
    );
  });
});

describe("public link prefills", () => {
  it.each([
    ["software-license", "seats", "12"],
    ["wifi", "hidden", "false"],
    ["wifi", "hidden", "true"],
    ["passport", "issuingCountry", "US"],
    ["server", "consoleUrl", "https://example.com"],
  ])("accepts a declared %s %s scalar", (type, field, value) => {
    expect(
      prefillNewDraft(type, new URLSearchParams({ [`field.${field}`]: value })),
    ).toMatchObject({ values: { [field]: value } });
  });
  it.each([
    ["software-license", "seats", "0xFF"],
    ["software-license", "seats", "1e999"],
    ["wifi", "hidden", "yes"],
    ["passport", "issuingCountry", "USA"],
    ["account", "uris", "https://example.com"],
    ["software-license", "registeredEmail", "private@example.com"],
  ])("refuses an invalid %s %s scalar", (type, field, value) => {
    expect(() =>
      prefillNewDraft(type, new URLSearchParams({ [`field.${field}`]: value })),
    ).toThrow("invalid_prefill");
  });
  it("bounds the whole query and puts a connection reference on a server", () => {
    expect(() =>
      readDraftPrefill(new URLSearchParams({ name: "x".repeat(2049) })),
    ).toThrow("invalid_prefill");
    const secret = prefillNewDraft(
      "secret",
      new URLSearchParams({ ref: "conn/github/pat" }),
    );
    expect(secret.kind === "secret" ? secret.connectionRef : "x").toBe("");
    expect(
      prefillNewDraft(
        "server",
        new URLSearchParams({ ref: "conn/github/pat" }),
      ),
    ).toMatchObject({
      typeId: "server",
      values: { connectionRef: "conn/github/pat" },
    });
    expect(
      prefillNewDraft(
        "database",
        new URLSearchParams({ ref: "conn/github/pat" }),
      ),
    ).toMatchObject({
      typeId: "database",
      values: { connectionRef: "conn/github/pat" },
    });
  });
  it("validates typed public fields against their manifest and rejects secret fields", () => {
    expect(
      prefillNewDraft(
        "database",
        new URLSearchParams({
          "field.engine": "postgresql",
          "field.databaseName": "public_demo",
        }),
      ),
    ).toMatchObject({
      values: { engine: "postgresql", databaseName: "public_demo" },
    });
    for (const query of [
      "field.password=secret",
      "field.connectionString=secret",
      "field.engine=bad",
      "field.missing=value",
      "username=one&field.username=two",
    ]) {
      expect(() =>
        prefillNewDraft("database", new URLSearchParams(query)),
      ).toThrow("invalid_prefill");
    }
  });
  it("uses public labels and a website without replacing generated secrets", () => {
    const item = prefillNewDraft(
      "account",
      new URLSearchParams({
        name: "Example",
        username: "public_alias",
        uri: "https://example.com/login",
        folder: "work",
      }),
    );
    expect(item).toMatchObject({
      name: "Example",
      username: "public_alias",
      folderId: "work",
      uris: [{ uri: "https://example.com/login" }],
    });
    if (item.kind !== "account") throw new Error("fixture");
    expect(visiblePassword(item)).toHaveLength(20);
  });
  it("keeps a fresh root in the first password method, which computes a password under the rules", () => {
    const item = newItemDraft("account");
    if (item.kind !== "account") throw new Error("fixture");
    const [first, ...rest] = item.methods;
    expect(rest).toEqual([]);
    // Pepper is on by default, at the end: no position is kept.
    expect(first).toMatchObject({
      type: "password",
      pepper: true,
      generator: { id: "derived", counter: 0, rules: { length: 20 } },
    });
    // A root is 32 bytes, base64; what the person sees is what it computes.
    expect(first?.type === "password" ? first.secret : "").toHaveLength(44);
    expect(first?.type === "password" ? first.sealed : "x").toBeUndefined();
  });
  it("still opens an account draft for the retired login name", () => {
    const item = prefillNewDraft(
      "login",
      new URLSearchParams({ uri: "https://example.com" }),
    );
    expect(item.kind).toBe("account");
    expect(newItemDraft("login").kind).toBe("account");
  });
  it("derives the label and RP hostname from a valid site, not its port", () => {
    expect(
      prefillNewDraft(
        "passkey",
        new URLSearchParams({ uri: "https://example.com:8443" }),
      ),
    ).toMatchObject({ name: "example.com", rpId: "example.com" });
    expect(
      prefillNewDraft("database", new URLSearchParams({ username: "db_user" })),
    ).toMatchObject({ values: { username: "db_user" } });
  });
  it.each([
    "password=secret",
    "totp=seed",
    "value=secret",
    "notes=secret",
    "name=one&name=two",
    "name=%00bad",
    "username=%E2%80%AEhidden",
    "uri=javascript:alert(1)",
    "uri=https://user:password@example.com",
    "uri=https://example.com/?token=secret",
    "uri=https://example.com/%23safe#secret",
    "folder=../../private",
    "ref=https://attacker.example",
    `name=${"x".repeat(121)}`,
  ])("refuses %s without echoing its value", (query) => {
    expect(() => readDraftPrefill(new URLSearchParams(query))).toThrow(
      "invalid_prefill",
    );
  });
});
