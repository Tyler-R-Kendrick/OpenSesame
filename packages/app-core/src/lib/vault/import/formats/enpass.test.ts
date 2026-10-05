/**
 * The Enpass JSON importer against the shape Enpass 6 writes: items as a
 * title, a category and typed fields; folders listed once by uuid.
 */
import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { detectFormat, parseImport } from "../index.js";
import type { DetectInput } from "../types.js";
import { enpassJson } from "./enpass.js";

function field(
  type: string,
  label: string,
  value: string,
  sensitive = 0,
): JsonObject {
  return { deleted: 0, label, order: 1, sensitive, type, uid: 1, value };
}

const EXPORT: JsonObject = {
  folders: [
    { icon: "1008", parent_uuid: "", title: "Banking", uuid: "f-bank" },
  ],
  items: [
    {
      archived: 0,
      category: "login",
      createdAt: 1_700_000_000,
      favorite: 1,
      fields: [
        field("username", "Username", "ada"),
        field("email", "E-mail", "ada@example.com"),
        field("password", "Password", "correct horse", 1),
        field("url", "Website", "https://bank.example"),
        field("totp", "One-time code", "JBSWY3DPEHPK3PXPJBSWY3DP", 1),
        field("section", "Security questions", ""),
        field("text", "Memorable word", "lighthouse", 1),
        { ...field("text", "Removed", "gone"), deleted: 1 },
      ],
      folders: ["f-bank"],
      note: "Call before travelling.",
      template_type: "login.default",
      title: "Bank of Example",
      trashed: 0,
      updated_at: 1_700_000_500,
      uuid: "i-1",
      attachments: [{ name: "statement.pdf", data: "JVBERi0=" }],
    },
    {
      category: "creditcard",
      fields: [
        field("ccName", "Cardholder", "Ada Lovelace"),
        field("ccNumber", "Number", "4111111111111111", 1),
        field("ccCvc", "CVC", "123", 1),
        field("ccExpiry", "Expiry date", "07/29"),
        field("ccType", "Type", "Visa"),
        field("ccPin", "PIN", "4321", 1),
      ],
      template_type: "creditcard.default",
      title: "Travel card",
      trashed: 0,
      uuid: "i-2",
    },
    {
      category: "note",
      fields: [],
      note: "Wi-Fi at the cabin: pinecone",
      template_type: "note.default",
      title: "Cabin",
      trashed: 0,
      uuid: "i-3",
    },
    {
      category: "login",
      fields: [field("password", "Password", "old")],
      template_type: "login.default",
      title: "Deleted login",
      trashed: 1,
      uuid: "i-4",
    },
  ],
};

function input(json: JsonObject): DetectInput {
  return {
    fileName: "enpass.json",
    text: JSON.stringify(json),
    headers: null,
    json,
    bytes: null,
  };
}

describe("Enpass JSON", () => {
  it("is what the detection chain picks for an Enpass export, and only that", () => {
    expect(detectFormat(input(EXPORT))?.id).toBe("enpass-json");
    expect(enpassJson.detect(input({ items: [{ name: "x" }] }))).toBe(false);
    expect(enpassJson.detect(input({ vaults: {} }))).toBe(false);
  });

  it("brings a login across with its folder, code, URLs and extra fields", () => {
    const result = parseImport(input(EXPORT));
    const [login] = result.items;
    expect(login).toMatchObject({
      kind: "account",
      name: "Bank of Example",
      username: "ada",
      password: "correct horse",
      totp: "JBSWY3DPEHPK3PXPJBSWY3DP",
      uris: [{ uri: "https://bank.example", match: "domain" }],
      folder: "Banking",
      favorite: true,
      notes: "Call before travelling.",
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_500_000).toISOString(),
    });
    // The e-mail the username took precedence over, and the custom field;
    // no section header, nothing deleted.
    expect(login?.fields).toEqual([
      { name: "E-mail", value: "ada@example.com", hidden: false },
      { name: "Memorable word", value: "lighthouse", hidden: true },
    ]);
  });

  it("brings a card across, its PIN hidden", () => {
    const card = parseImport(input(EXPORT)).items[1];
    expect(card).toMatchObject({
      kind: "card",
      cardholder: "Ada Lovelace",
      number: "4111111111111111",
      code: "123",
      brand: "Visa",
      expMonth: "07",
      expYear: "2029",
      fields: [{ name: "PIN", value: "4321", hidden: true }],
    });
  });

  it("keeps notes, skips the trash, and says what it left behind", () => {
    const result = parseImport(input(EXPORT));
    expect(result.items.map((item) => item.name)).toEqual([
      "Bank of Example",
      "Travel card",
      "Cabin",
    ]);
    expect(result.items[2]).toMatchObject({
      kind: "note",
      notes: "Wi-Fi at the cabin: pinecone",
    });
    expect(result.warnings).toEqual([
      "1 item was in the Enpass trash, and not imported.",
      "1 attachment was left behind. Add each again as a File item.",
    ]);
  });
});
