import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  type BitwardenNativeKey,
  decodeBitwardenKey,
} from "./bitwarden-native-cose.js";
import {
  nativeCipherWire,
  nativeObject,
  nativePersonalCipher,
  nativeText,
} from "./bitwarden-native-item.js";
import {
  createBitwardenLegacyItem,
  readBitwardenLegacyItem,
  updateBitwardenLegacyItem,
} from "./bitwarden-native-legacy-item.js";
import type { SecretBackendItemInput } from "./types.js";

const USER = Buffer.from(Array.from({ length: 64 }, (_, i) => i + 9));
const ITEM = Buffer.from(Array.from({ length: 64 }, (_, i) => 200 - i));
const ID = "e561cf34-c322-48a4-a274-7577766b028a";
function seal(text: string | Buffer, key: Uint8Array = ITEM): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]);
  const tag = createHmac("sha256", key.subarray(32))
    .update(iv)
    .update(ciphertext)
    .digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${tag.toString("base64")}`;
}
function open(value: BoundaryValue, key: Uint8Array = ITEM): Buffer {
  const parts = nativeText(value)
    .slice(2)
    .split("|")
    .map((part) => Buffer.from(part, "base64"));
  const [iv, ciphertext, tag] = parts;
  const expected = createHmac("sha256", key.subarray(32))
    .update(iv)
    .update(ciphertext)
    .digest();
  expect(timingSafeEqual(tag, expected)).toBe(true);
  const decipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function objects(value: BoundaryValue): JsonObject[] {
  return z.array(z.json()).parse(value).map(nativeObject);
}
function user(): BitwardenNativeKey {
  return decodeBitwardenKey(new Uint8Array(USER));
}
function login(key = ITEM): JsonObject {
  return {
    username: seal("owner", key),
    password: seal("old secret", key),
    totp: seal("TOTP-untouched", key),
    uris: [
      {
        uri: seal("https://first.example.test", key),
        match: 2,
        uriChecksum: seal(
          createHash("sha256")
            .update("https://first.example.test")
            .digest("base64"),
          key,
        ),
        extraUri: { keep: true },
      },
      { uri: seal("https://second.example.test", key), match: 4 },
    ],
    fido2Credentials: [
      { keyValue: seal("passkey untouched", key), unknownPasskey: 9 },
    ],
    autofillOnPageLoad: true,
    unknownLogin: { keep: "verbatim" },
  };
}
function fixture(keyed = true): JsonObject {
  const key = keyed ? ITEM : USER;
  return nativeCipherWire({
    id: ID,
    type: 1,
    organizationId: null,
    folderId: "folder-one",
    revisionDate: "2026-10-01T01:02:03Z",
    name: seal("Original 🔐", key),
    notes: seal("old note", key),
    login: login(key),
    key: keyed ? seal(ITEM, USER) : null,
    fields: [
      {
        name: seal("Team", key),
        value: seal("Platform", key),
        type: 0,
        unknownField: { keep: true },
      },
      {
        name: seal("Untouched", key),
        value: seal("Exact bytes", key),
        type: 1,
      },
      {
        name: seal("Linked", key),
        value: seal("Linked value", key),
        type: 3,
        linkedId: 100,
      },
    ],
    passwordHistory: [
      {
        password: seal("older password", key),
        lastUsedDate: "2025-01-01T00:00:00Z",
        extra: true,
      },
    ],
    attachments: [
      {
        id: "attachment-one",
        fileName: seal("private.txt", key),
        key: seal(Buffer.alloc(64, 3), key),
        size: "19",
      },
    ],
    favorite: true,
    reprompt: 1,
    edit: true,
    viewPassword: true,
    unknownTop: { future: [1, 2, { keep: "all" }] },
  });
}
const edit: SecretBackendItemInput = {
  name: "Edited 🔐",
  notes: "new private note",
  secret: "new private secret",
  username: "new user",
  url: "https://changed.example.test/🔐",
  fields: { Team: "Security" },
};
it.each([true, false])(
  "reads and losslessly updates actual keyed=%s legacy encrypted logins",
  (keyed) => {
    const wire = fixture(keyed);
    const snapshot = JSON.stringify(wire);
    const account = user();
    const before = readBitwardenLegacyItem(wire, account);
    expect(before).toMatchObject({
      id: ID,
      name: "Original 🔐",
      kind: "login",
      username: "owner",
      secret: "old secret",
      url: "https://first.example.test",
    });
    const body = updateBitwardenLegacyItem(wire, edit, account);
    const after = readBitwardenLegacyItem(body, account);
    expect(after).toMatchObject({
      id: ID,
      name: edit.name,
      notes: edit.notes,
      secret: edit.secret,
      username: edit.username,
      url: edit.url,
      kind: "login",
    });
    expect(body.key).toBe(wire.key);
    expect(body.revisionDate).toBe(wire.revisionDate);
    for (const member of [
      "unknownTop",
      "attachments",
      "favorite",
      "reprompt",
      "folderId",
    ])
      expect(body[member]).toEqual(wire[member]);
    const data = nativeObject(body.login);
    const prior = nativeObject(wire.login);
    for (const member of [
      "totp",
      "fido2Credentials",
      "autofillOnPageLoad",
      "unknownLogin",
    ])
      expect(data[member]).toEqual(prior[member]);
    const uris = objects(data.uris);
    const oldUris = objects(prior.uris);
    expect(uris[1]).toEqual(oldUris[1]);
    expect(uris[0].match).toBe(2);
    expect(uris[0].extraUri).toEqual(oldUris[0].extraUri);
    const key = keyed ? ITEM : USER;
    expect(open(uris[0].uriChecksum, key).toString()).toBe(
      createHash("sha256")
        .update(edit.url ?? "")
        .digest("base64"),
    );
    const history = objects(body.passwordHistory);
    expect(history[0].password).toBe(prior.password);
    expect(history[1]).toEqual(objects(wire.passwordHistory)[0]);
    expect(open(nativeObject(body.login).password, key).toString()).toBe(
      edit.secret,
    );
    expect(JSON.stringify(wire)).toBe(snapshot);
    expect(Buffer.from(account.material)).toEqual(USER);
  },
);
it.each(["note", "secret", "login"] as const)(
  "creates independently decryptable %s items with fresh wrapped keys and IVs",
  (kind) => {
    const input: SecretBackendItemInput = { ...edit, kind };
    const account = user();
    const first = createBitwardenLegacyItem(input, account, "folder-two");
    const second = createBitwardenLegacyItem(input, account, "folder-two");
    const firstKey = open(first.key, USER);
    const secondKey = open(second.key, USER);
    expect(firstKey).toHaveLength(64);
    expect(firstKey.equals(secondKey)).toBe(false);
    expect(first.name).not.toBe(second.name);
    expect(open(first.name, firstKey).toString()).toBe(edit.name);
    expect(open(first.notes, firstKey).toString()).toBe(edit.notes);
    const read = readBitwardenLegacyItem({ ...first, id: ID }, account);
    expect(read).toMatchObject({
      name: edit.name,
      notes: edit.notes,
      secret: edit.secret,
      kind,
    });
    expect(first.folderId).toBe("folder-two");
    expect(first.organizationId).toBeNull();
    expect(first.id).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain(edit.notes);
    expect(JSON.stringify(first)).not.toContain(edit.secret);
  },
);
it("preserves unspecified login URIs, username, fields, password history and password revision", () => {
  const wire = fixture();
  const before = readBitwardenLegacyItem(wire, user());
  const prior = nativeObject(wire.login);
  prior.passwordRevisionDate = "2025-01-02T00:00:00Z";
  const updated = updateBitwardenLegacyItem(
    wire,
    { name: before.name, notes: "only note changed", secret: before.secret },
    user(),
  );
  const data = nativeObject(updated.login);
  for (const member of [
    "username",
    "uris",
    "totp",
    "fido2Credentials",
    "passwordRevisionDate",
  ])
    expect(data[member]).toEqual(prior[member]);
  expect(updated.passwordHistory).toEqual(wire.passwordHistory);
  expect(updated.fields).toEqual(wire.fields);
});
it("keeps duplicate unmentioned custom fields; rejects an ambiguous edit without dropping either", () => {
  const wire = fixture();
  const fields = objects(wire.fields);
  fields.push({ name: seal("Untouched"), value: seal("duplicate"), type: 1 });
  wire.fields = fields;
  const okay = updateBitwardenLegacyItem(
    wire,
    { ...edit, fields: { Team: "Updated" } },
    user(),
  );
  expect(objects(okay.fields).slice(1)).toEqual(fields.slice(1));
  expect(() =>
    updateBitwardenLegacyItem(
      wire,
      { ...edit, fields: { Untouched: "unsafe ambiguity" } },
      user(),
    ),
  ).toThrow(/multiple/);
});
it("does not overwrite linked custom fields and preserves their unknown wire metadata", () => {
  const wire = fixture();
  expect(() =>
    updateBitwardenLegacyItem(
      wire,
      { ...edit, fields: { Linked: "Changed" } },
      user(),
    ),
  ).toThrow(/Linked/);
  expect(
    updateBitwardenLegacyItem(
      wire,
      { ...edit, fields: { Linked: "Linked value" } },
      user(),
    ).fields,
  ).toEqual(wire.fields);
});
it("rejects duplicate managed secrets, reserved input fields and contradictory API casing", () => {
  const wire = fixture();
  wire.type = 2;
  wire.login = null;
  wire.fields = [
    { name: seal("opensesame_secret"), value: seal("one"), type: 1 },
    { name: seal("opensesame_secret"), value: seal("two"), type: 1 },
  ];
  expect(() => readBitwardenLegacyItem(wire, user())).toThrow();
  expect(() =>
    createBitwardenLegacyItem(
      { ...edit, fields: { opensesame_secret: "override" } },
      user(),
    ),
  ).toThrow();
  expect(() => nativeCipherWire({ ...fixture(), Type: 2 })).toThrow();
});
it.each([
  "organization",
  "deleted",
  "partial",
  "hidden",
  "different folder",
  "unrelated kind",
])("excludes %s records without mutating their raw data", (caseName) => {
  const wire = fixture();
  const snapshot = JSON.stringify(wire);
  const source = { ...wire };
  if (caseName === "organization") source.organizationId = ID;
  if (caseName === "deleted") source.deletedDate = "2026-10-01T00:00:00Z";
  if (caseName === "partial") source.partialData = "restricted";
  if (caseName === "hidden") source.viewPassword = false;
  if (caseName === "unrelated kind") source.type = 3;
  expect(
    nativePersonalCipher(
      source,
      caseName === "different folder" ? "other-folder" : "",
    ),
  ).toBe(false);
  expect(JSON.stringify(wire)).toBe(snapshot);
});
it("filters invalid keyed URI checksums and preserves those entries when adding a valid URL", () => {
  const wire = fixture();
  const data = nativeObject(wire.login);
  const rows = objects(data.uris);
  rows[0].uriChecksum = seal("wrong checksum");
  data.uris = rows;
  expect(readBitwardenLegacyItem(wire, user()).url).toBe("");
  const updated = updateBitwardenLegacyItem(wire, edit, user());
  const next = objects(nativeObject(updated.login).uris);
  expect(next.slice(0, 2)).toEqual(rows);
  expect(readBitwardenLegacyItem(updated, user()).url).toBe(edit.url);
});
it("rejects tampered fields, malformed UTF8 and modern blob downgrade", () => {
  const wire = fixture();
  wire.notes = seal(Buffer.from([0xff]));
  expect(() => readBitwardenLegacyItem(wire, user())).toThrow();
  wire.notes = "2.bad|bad|bad";
  expect(() => readBitwardenLegacyItem(wire, user())).toThrow();
  wire.data = "modern payload";
  expect(() => readBitwardenLegacyItem(wire, user())).toThrow();
});
it("refuses a read-only mutation while retaining ordinary read capability", () => {
  const wire = fixture();
  wire.edit = false;
  expect(readBitwardenLegacyItem(wire, user()).name).toBe("Original 🔐");
  expect(() => updateBitwardenLegacyItem(wire, edit, user())).toThrow(
    /read-only/,
  );
});
it("bounds text before encrypting and rejects malformed scalar strings", () => {
  expect(() =>
    createBitwardenLegacyItem({ ...edit, notes: "x".repeat(524289) }, user()),
  ).toThrow();
  expect(() =>
    createBitwardenLegacyItem({ ...edit, name: "\ud800" }, user()),
  ).toThrow();
});
