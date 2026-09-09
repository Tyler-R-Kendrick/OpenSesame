import { describe, expect, it } from "vitest";
import {
  installItemType,
  itemTypeRegistry,
  syncInstalledTypes,
} from "./item-types.js";
import { createItem } from "./model.js";
import {
  acceptsDraftUsername,
  generateDraftLabels,
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
    const first = newItemDraft("login");
    const second = newItemDraft("login");
    if (first.kind !== "login" || second.kind !== "login")
      throw new Error("fixture");
    expect(first.password).toHaveLength(20);
    expect(first.password).not.toBe(second.password);
    expect(first.username).toMatch(/^user_[a-f0-9]+$/);
    expect(first.username).not.toBe(second.username);
    expect(first.totp).toBe("");
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
    expect(createItem("login").password).toBe("");
    expect(() => newItemDraft("missing-type")).toThrow(
      "Unknown vault item type",
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
    ["login", "uris", "https://example.com"],
    ["software-license", "registeredEmail", "private@example.com"],
  ])("refuses an invalid %s %s scalar", (type, field, value) => {
    expect(() =>
      prefillNewDraft(type, new URLSearchParams({ [`field.${field}`]: value })),
    ).toThrow("invalid_prefill");
  });
  it("bounds the whole query and preserves compatible connection references", () => {
    expect(() =>
      readDraftPrefill(new URLSearchParams({ name: "x".repeat(2049) })),
    ).toThrow("invalid_prefill");
    expect(
      prefillNewDraft(
        "secret",
        new URLSearchParams({ ref: "conn/github/pat" }),
      ),
    ).toMatchObject({ connectionRef: "conn/github/pat" });
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
      "login",
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
    if (item.kind !== "login") throw new Error("fixture");
    expect(item.password).toHaveLength(20);
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
