import { describe, expect, it } from "vitest";

import { fidoCxf } from "../import/formats/cxf.js";
import type { DraftItem, ParseInput } from "../import/types.js";
import type { VaultBody, VaultItem } from "../model.js";
import {
  CXF_EXTENSION,
  CXF_TYPES,
  CXF_VERSION,
  type CxfDocument,
  CxfExportError,
  buildCxfExport,
  cxfExportSeams,
  cxfFileName,
  serializeCxfExport,
} from "./cxf.js";

const NOW = "2026-03-04T05:06:07.000Z";

function base(kind: VaultItem["kind"], id: string, name: string) {
  return {
    id,
    kind,
    name,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

/** One item of every kind the vault has, with every field populated. */
function fullVault(): VaultBody {
  const login: VaultItem = {
    ...base("login", "item-login", "Example Mail"),
    kind: "login",
    folderId: "folder-work",
    favorite: true,
    notes: "First line\nSecond line",
    fields: [
      { id: "f1", name: "Recovery Code", value: "abcd-efgh", hidden: false },
      { id: "f2", name: "Support PIN", value: "9182", hidden: true },
    ],
    username: "ada@example.com",
    password: "hunter2",
    totp: "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=45&algorithm=SHA256",
    uris: [
      { id: "u1", uri: "https://mail.example.com", match: "domain" },
      { id: "u2", uri: "https://webmail.example.com", match: "domain" },
    ],
    passwordChangedAt: NOW,
  };
  const passkey: VaultItem = {
    ...base("passkey", "item-passkey", "example.org passkey"),
    kind: "passkey",
    folderId: "folder-work",
    rpId: "example.org",
    username: "ada@example.org",
    credentialIdB64: "Y3JlZC1pZC0wMDE=",
    publicKeyB64: "cHVibGljLWtleS1ieXRlcw==",
    authenticator: "cross-platform",
    unlocksVault: true,
  };
  const card: VaultItem = {
    ...base("card", "item-card", "Company Card"),
    kind: "card",
    cardholder: "Ada Lovelace",
    brand: "Visa",
    number: "4111111111111111",
    expMonth: "07",
    expYear: "2031",
    code: "123",
  };
  const secret: VaultItem = {
    ...base("secret", "item-secret", "Deploy Token"),
    kind: "secret",
    notes: "Rotate quarterly.",
    value: "sk-live-0123456789",
    ceiling: [{ id: "g1", action: "deploy", resource: "prod" }],
    grantees: ["agent-alpha"],
    connectionRef: "conn:github:deploy",
  };
  const note: VaultItem = {
    ...base("note", "item-note", "Safe combination"),
    kind: "note",
    notes: "Left 12, right 4, left 30",
    fields: [{ id: "f3", name: "Location", value: "Study", hidden: false }],
  };
  const certificate: VaultItem = {
    ...base("certificate", "item-cert", "Local dev cert"),
    kind: "certificate",
    commonName: "localhost",
    dnsNames: "localhost",
    ipAddrs: "127.0.0.1",
    ttlHours: "24",
    certificatePem: "-----BEGIN CERTIFICATE-----",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----",
    caPem: "",
    serial: "01",
    notAfter: "2026-04-04T00:00:00.000Z",
  };
  const deleted: VaultItem = {
    ...base("login", "item-deleted", "Old Account"),
    kind: "login",
    username: "gone",
    password: "gone",
    totp: "",
    uris: [],
    passwordChangedAt: NOW,
    deletedAt: NOW,
  };

  return {
    v: 1,
    items: [login, passkey, card, secret, note, certificate, deleted],
    folders: [
      { id: "folder-work", name: "Work", createdAt: NOW },
      { id: "folder-empty", name: "Nothing In Here", createdAt: NOW },
    ],
  };
}

function exported(body = fullVault()): CxfDocument {
  return buildCxfExport(body, {
    humanConfirmed: true,
    exportedAt: new Date(NOW),
  }).document;
}

function reimport(document: CxfDocument): DraftItem[] {
  const text = serializeCxfExport(document);
  const input: ParseInput = {
    fileName: "export.json",
    text,
    headers: null,
    json: JSON.parse(text),
    bytes: null,
  };
  expect(fidoCxf.detect(input)).toBe(true);
  return fidoCxf.parse(input).items;
}

describe("the human-plane ceremony", () => {
  it("refuses to serialize the vault without an explicit confirmation", () => {
    // The whole point of the flag: a caller that forgets it gets nothing.
    // A CXF document is every secret in the vault, in the clear.
    const body = fullVault();
    const options = { humanConfirmed: false };
    expect(() => cxfExportSeams.buildCxfExport(body, options)).toThrow(
      CxfExportError,
    );
    expect(() => cxfExportSeams.buildCxfExport(body, options)).toThrow(
      /explicit human confirmation/,
    );
  });

  it("names the file by the day it was written", () => {
    expect(cxfFileName(new Date("2026-03-04T05:06:07Z"))).toBe(
      "opensesame-cxf-2026-03-04.json",
    );
  });

  it("refuses to serialize a document claiming another CXF version", () => {
    const document = { ...exported(), version: 2 };
    expect(() => cxfExportSeams.serializeCxfExport(document)).toThrow(
      /unknown CXF version/,
    );
  });
});

describe("what the exported document contains", () => {
  it("writes a CXF header naming this exporter", () => {
    const document = exported();
    expect(document.version).toBe(CXF_VERSION);
    expect(document.exporter).toBe("OpenSesame");
    expect(document.timestamp).toBe(Math.floor(Date.parse(NOW) / 1000));
    expect(document.accounts).toHaveLength(1);
  });

  it("leaves deleted items out", () => {
    const titles = exported().accounts[0]?.items.map((item) => item.title);
    expect(titles).not.toContain("Old Account");
  });

  it("declines the one item kind CXF cannot express, with a reason", () => {
    const { document, skipped } = buildCxfExport(fullVault(), {
      humanConfirmed: true,
    });
    expect(skipped).toEqual([
      { name: "Local dev cert", reason: expect.stringContaining("X.509") },
    ]);
    expect(JSON.stringify(document)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("writes a collection only for a folder something is actually in", () => {
    const collections = exported().accounts[0]?.collections ?? [];
    expect(collections.map((collection) => collection.title)).toEqual(["Work"]);
    expect(collections[0]?.items).toEqual([
      { item: "item-login" },
      { item: "item-passkey" },
    ]);
  });

  it("never writes a passkey private key, because it never has one", () => {
    const passkey = exported()
      .accounts[0]?.items.find((item) => item.id === "item-passkey")
      ?.credentials.find((credential) => credential.type === CXF_TYPES.passkey);
    if (passkey?.type !== CXF_TYPES.passkey) throw new Error("no passkey");
    expect(passkey.key).toBe("");
    // base64url on the wire, so it survives a URL and a QR code alike.
    expect(passkey.credentialId).toBe("Y3JlZC1pZC0wMDE");
    expect(passkey.extensions?.[0]?.name).toBe(CXF_EXTENSION);
    expect(passkey.extensions?.[0]?.publicKey).toBe("cHVibGljLWtleS1ieXRlcw");
  });

  it("marks a value CXF calls concealed wherever the vault called it hidden", () => {
    const item = exported().accounts[0]?.items.find(
      (row) => row.id === "item-login",
    );
    const basic = item?.credentials.find(
      (credential) => credential.type === CXF_TYPES.basicAuth,
    );
    if (basic?.type !== CXF_TYPES.basicAuth) throw new Error("no basic-auth");
    expect(basic.password?.fieldType).toBe("concealed-string");
    expect(basic.username?.fieldType).toBe("string");

    const custom = item?.credentials.find(
      (credential) => credential.type === CXF_TYPES.customFields,
    );
    if (custom?.type !== CXF_TYPES.customFields) {
      throw new Error("no custom fields");
    }
    expect(custom.fields.map((field) => field.fieldType)).toEqual([
      "string",
      "concealed-string",
    ]);
  });

  it("splits a TOTP URI into the parameters CXF models", () => {
    const totp = exported()
      .accounts[0]?.items.find((row) => row.id === "item-login")
      ?.credentials.find((credential) => credential.type === CXF_TYPES.totp);
    if (totp?.type !== CXF_TYPES.totp) throw new Error("no totp");
    expect(totp.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(totp.digits).toBe(8);
    expect(totp.period).toBe(45);
    expect(totp.algorithm).toBe("sha256");
    expect(totp.issuer).toBe("Example");
  });

  it("writes a card expiry as a year-month field", () => {
    const card = exported()
      .accounts[0]?.items.find((row) => row.id === "item-card")
      ?.credentials.find(
        (credential) => credential.type === CXF_TYPES.creditCard,
      );
    if (card?.type !== CXF_TYPES.creditCard) throw new Error("no card");
    expect(card.expiryDate).toEqual({
      fieldType: "year-month",
      value: "2031-07",
    });
  });

  it("ends the serialized document with a newline and pretty-prints it", () => {
    const text = serializeCxfExport(exported());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": 1');
  });
});

describe("export then import", () => {
  it("brings every item back with its values intact", () => {
    const items = reimport(exported());
    expect(items.map((item) => item.name)).toEqual([
      "Example Mail",
      "example.org passkey",
      "Company Card",
      "Deploy Token",
      "Safe combination",
    ]);

    const login = items.find((item) => item.kind === "login");
    if (login?.kind !== "login") throw new Error("no login");
    expect(login).toMatchObject({
      name: "Example Mail",
      folder: "Work",
      favorite: true,
      notes: "First line\nSecond line",
      username: "ada@example.com",
      password: "hunter2",
      totp: "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=45&algorithm=SHA256",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(login.uris.map((uri) => uri.uri)).toEqual([
      "https://mail.example.com",
      "https://webmail.example.com",
    ]);
    expect(login.fields).toEqual([
      { name: "Recovery Code", value: "abcd-efgh", hidden: false },
      { name: "Support PIN", value: "9182", hidden: true },
    ]);

    const card = items.find((item) => item.kind === "card");
    if (card?.kind !== "card") throw new Error("no card");
    expect(card).toMatchObject({
      cardholder: "Ada Lovelace",
      brand: "Visa",
      number: "4111111111111111",
      expMonth: "07",
      expYear: "2031",
      code: "123",
    });

    const secret = items.find((item) => item.kind === "secret");
    if (secret?.kind !== "secret") throw new Error("no secret");
    expect(secret.value).toBe("sk-live-0123456789");
    expect(secret.notes).toBe("Rotate quarterly.");
    expect(secret.fields).toContainEqual({
      name: "Connection",
      value: "conn:github:deploy",
      hidden: false,
    });

    const note = items.find((item) => item.kind === "note");
    if (note?.kind !== "note") throw new Error("no note");
    expect(note.notes).toBe("Left 12, right 4, left 30");
    expect(note.fields).toEqual([
      { name: "Location", value: "Study", hidden: false },
    ]);
  });

  /**
   * The headline. Every other interchange format on this page either drops a
   * passkey outright or flattens it into a note nobody can use. CXF is the one
   * that carries it, and this is the assertion that keeps that true.
   */
  it("round-trips a passkey with full fidelity", () => {
    const items = reimport(exported());
    const passkey = items.find((item) => item.kind === "passkey");
    if (passkey?.kind !== "passkey") throw new Error("no passkey");
    expect(passkey).toMatchObject({
      kind: "passkey",
      name: "example.org passkey",
      folder: "Work",
      rpId: "example.org",
      username: "ada@example.org",
      credentialIdB64: "Y3JlZC1pZC0wMDE=",
      publicKeyB64: "cHVibGljLWtleS1ieXRlcw==",
      authenticator: "cross-platform",
    });
  });

  it("survives a vault of nothing but a passkey", () => {
    const body = fullVault();
    body.items = body.items.filter((item) => item.kind === "passkey");
    body.folders = [];
    const items = reimport(exported(body));
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("passkey");
  });

  it("keeps an empty note from vanishing between the two", () => {
    const body: VaultBody = {
      v: 1,
      items: [{ ...base("note", "n", "Blank"), kind: "note" }],
      folders: [],
    };
    const items = reimport(exported(body));
    expect(items).toEqual([
      expect.objectContaining({ kind: "note", name: "Blank", notes: "" }),
    ]);
  });
});
