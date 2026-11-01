import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { type CBORType, decodeCBOR, encodeCBOR } from "@levischuck/tiny-cbor";
import type { JsonObject } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import {
  createBitwardenBlobItem,
  readBitwardenBlobItem,
  updateBitwardenBlobItem,
} from "./bitwarden-native-blob-item.js";
import { openBitwardenWrappedKey } from "./bitwarden-native-blob.js";
import {
  type BitwardenCborMap,
  type BitwardenNativeKey,
  bitwardenCborBytes,
  bitwardenCborMap,
  decodeBitwardenKey,
} from "./bitwarden-native-cose.js";
import { nativeText } from "./bitwarden-native-item.js";
import type { SecretBackendItemInput } from "./types.js";
const USER = Uint8Array.from({ length: 64 }, (_, i) => i + 3);
const ITEM = Uint8Array.from({ length: 64 }, (_, i) => 170 - i);
const ID = "c34ddfb6-a7d3-43a7-a1bd-f6269e127d5d";
const key = () => decodeBitwardenKey(USER);
const map = (entries: [string | number, CBORType][]): BitwardenCborMap =>
  new Map(entries);
function pad(value: Uint8Array, minimum: number): Uint8Array {
  const length = Math.max(1, minimum - value.length);
  return new Uint8Array(Buffer.concat([value, Buffer.alloc(length, length)]));
}
function wrap(value: Uint8Array, material: Uint8Array): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", material.slice(0, 32), iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  const tag = createHmac("sha256", material.slice(32))
    .update(iv)
    .update(encrypted)
    .digest();
  return `2.${iv.toString("base64")}|${encrypted.toString("base64")}|${tag.toString("base64")}`;
}
function unwrap(text: string, material: Uint8Array): Uint8Array {
  const [iv, encrypted, tag] = text
    .slice(2)
    .split("|")
    .map((part) => Buffer.from(part, "base64"));
  expect(
    timingSafeEqual(
      tag,
      createHmac("sha256", material.slice(32))
        .update(iv)
        .update(encrypted)
        .digest(),
    ),
  ).toBe(true);
  const cipher = createDecipheriv("aes-256-cbc", material.slice(0, 32), iv);
  return new Uint8Array(
    Buffer.concat([cipher.update(encrypted), cipher.final()]),
  );
}
function fixture(model: BitwardenCborMap): JsonObject {
  const cek = randomBytes(32);
  const kid = randomBytes(16);
  const iv = randomBytes(12);
  const encodedKey = pad(
    encodeCBOR(
      map([
        [1, 4],
        [2, kid],
        [3, 3],
        [4, [4]],
        [-1, cek],
      ]),
    ),
    65,
  );
  const protectedBytes = encodeCBOR(
    map([
      [3, "application/x.bitwarden.cbor-padded"],
      [4, kid],
      [-80002, 2],
      [-80001, 1],
      [1, 3],
    ]),
  );
  const aad = encodeCBOR(["Encrypt0", protectedBytes, new Uint8Array()]);
  const cipher = createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(pad(encodeCBOR(model), 64)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    id: ID,
    type: 1,
    organizationId: null,
    folderId: "owned-folder",
    key: wrap(ITEM, USER),
    name: null,
    notes: null,
    data: JSON.stringify({
      format_version: 1,
      wrapped_cek: wrap(encodedKey, ITEM),
      envelope: Buffer.from(
        encodeCBOR([
          protectedBytes,
          new Map([[5, iv]]),
          new Uint8Array(ciphertext),
        ]),
      ).toString("base64"),
    }),
    revisionDate: "2026-10-01T00:00:00Z",
    edit: true,
    attachments: [{ opaque: "retained encrypted metadata" }],
    unknownTop: { future: [1, 2] },
  };
}
function open(text: string, item: Uint8Array = ITEM) {
  const container = JSON.parse(text);
  const encoded = unwrap(container.wrapped_cek, item);
  const cek = bitwardenCborMap(
    decodeCBOR(encoded.slice(0, -encoded[encoded.length - 1])),
  );
  const envelope = decodeCBOR(
    new Uint8Array(Buffer.from(container.envelope, "base64")),
  );
  if (!Array.isArray(envelope))
    throw new Error("Expected independent Encrypt0.");
  const headers = bitwardenCborBytes(envelope[0]);
  const nonce = bitwardenCborBytes(bitwardenCborMap(envelope[1]).get(5));
  const ciphertext = bitwardenCborBytes(envelope[2]);
  const material = bitwardenCborBytes(cek.get(-1));
  const cipher = createDecipheriv("aes-256-gcm", material, nonce);
  cipher.setAAD(encodeCBOR(["Encrypt0", headers, new Uint8Array()]));
  cipher.setAuthTag(ciphertext.slice(-16));
  const plaintext = Buffer.concat([
    cipher.update(ciphertext.slice(0, -16)),
    cipher.final(),
  ]);
  return {
    model: bitwardenCborMap(
      decodeCBOR(
        new Uint8Array(plaintext.slice(0, -plaintext[plaintext.length - 1])),
      ),
    ),
    material,
    nonce,
  };
}
function model(): BitwardenCborMap {
  return map([
    ["version", "1"],
    ["futureOuter", new Uint8Array([8, 9])],
    [
      "content",
      map([
        ["name", "owned modern 🔐"],
        ["notes", "private modern note"],
        [
          "typeData",
          map([
            ["type", "login"],
            ["username", "owner"],
            ["password", "old secret"],
            ["passwordRevisionDate", null],
            ["totp", "private TOTP"],
            [
              "fido2Credentials",
              [
                map([
                  ["keyValue", "private passkey"],
                  ["future", true],
                ]),
              ],
            ],
            [
              "uris",
              [
                map([
                  ["uri", "https://first.example.test"],
                  ["match", 2],
                  ["futureUri", new Uint8Array([1, 3])],
                ]),
                map([
                  ["uri", "https://second.example.test"],
                  ["match", 4],
                ]),
              ],
            ],
            ["futureLogin", map([[7, "retained"]])],
          ]),
        ],
        [
          "fields",
          [
            map([
              ["name", "Team"],
              ["value", "Platform"],
              ["type", 0],
              ["futureField", new Uint8Array([3, 4])],
            ]),
            map([
              ["name", "Retained"],
              ["value", "Private value"],
              ["type", 1],
            ]),
          ],
        ],
        [
          "passwordHistory",
          [
            map([
              ["password", "even older secret"],
              ["lastUsedDate", "2025-01-01T00:00:00Z"],
              ["future", true],
            ]),
          ],
        ],
        ["futureContent", [map([[4, "keep"]]), new Uint8Array([9, 1])]],
      ]),
    ],
  ]);
}
const edit: SecretBackendItemInput = {
  name: "updated modern 🔐",
  notes: "new modern private note",
  secret: "new modern private password",
  username: "new user",
  url: "https://new.example.test",
  fields: { Team: "Security" },
};
it("reads an independently encrypted current V2 blob and preserves all supported CBOR members on update", () => {
  const saved = model();
  const wire = fixture(saved);
  const snapshot = JSON.stringify(wire);
  const user = key();
  const original = readBitwardenBlobItem(wire, user);
  expect(original).toMatchObject({
    id: ID,
    name: "owned modern 🔐",
    notes: "private modern note",
    secret: "old secret",
    kind: "login",
    username: "owner",
    url: "https://first.example.test",
  });
  const updated = updateBitwardenBlobItem(wire, edit, user);
  const after = open(nativeText(updated.data));
  expect(readBitwardenBlobItem(updated, user)).toMatchObject({
    ...edit,
    id: ID,
    kind: "login",
  });
  for (const property of [
    "id",
    "key",
    "revisionDate",
    "folderId",
    "attachments",
    "unknownTop",
  ])
    expect(updated[property]).toEqual(wire[property]);
  expect(updated.name).toBeNull();
  expect(updated.notes).toBeNull();
  expect(JSON.stringify(updated)).not.toContain(edit.secret);
  expect(after.model.get("futureOuter")).toEqual(saved.get("futureOuter"));
  const content = bitwardenCborMap(after.model.get("content"));
  const before = bitwardenCborMap(saved.get("content"));
  expect(content.get("futureContent")).toEqual(before.get("futureContent"));
  const data = bitwardenCborMap(content.get("typeData"));
  const old = bitwardenCborMap(before.get("typeData"));
  for (const property of ["totp", "fido2Credentials", "futureLogin"])
    expect(data.get(property)).toEqual(old.get(property));
  const rows = data.get("uris");
  const oldRows = old.get("uris");
  if (!Array.isArray(rows) || !Array.isArray(oldRows))
    throw new Error("Expected URI arrays.");
  expect(rows[1]).toEqual(oldRows[1]);
  expect(bitwardenCborMap(rows[0]).get("futureUri")).toEqual(
    bitwardenCborMap(oldRows[0]).get("futureUri"),
  );
  const fields = content.get("fields");
  if (!Array.isArray(fields)) throw new Error("Expected fields.");
  expect(bitwardenCborMap(fields[0]).get("futureField")).toEqual(
    new Uint8Array([3, 4]),
  );
  const history = content.get("passwordHistory");
  if (!Array.isArray(history)) throw new Error("Expected history.");
  expect(bitwardenCborMap(history[0]).get("password")).toBe("old secret");
  expect(history).toHaveLength(2);
  expect(JSON.stringify(wire)).toBe(snapshot);
  expect(user.material).toEqual(USER);
});
it.each(["note", "secret", "login"] as const)(
  "creates independently decryptable V2 %s items with fresh CEK, nonce and item key",
  (kind) => {
    const first = createBitwardenBlobItem({ ...edit, kind }, key());
    const second = createBitwardenBlobItem({ ...edit, kind }, key());
    const item = unwrap(nativeText(first.key), USER);
    const another = unwrap(nativeText(second.key), USER);
    expect(item).not.toEqual(another);
    const decoded = open(nativeText(first.data), item);
    const other = open(nativeText(second.data), another);
    expect(decoded.material).not.toEqual(other.material);
    expect(decoded.nonce).not.toEqual(other.nonce);
    expect(bitwardenCborMap(decoded.model.get("content")).get("name")).toBe(
      edit.name,
    );
    expect(readBitwardenBlobItem({ ...first, id: ID }, key())).toMatchObject({
      id: ID,
      kind,
      name: edit.name,
      notes: edit.notes,
      secret: edit.secret,
    });
  },
);
it("composes actual XAES user-key wrapping for newly created modern account items", () => {
  const user: BitwardenNativeKey = {
    algorithm: -70010,
    material: new Uint8Array(32).fill(42),
    id: new Uint8Array(16).fill(19),
    operations: [3, 4, 5, 6],
  };
  const wire = createBitwardenBlobItem({ ...edit, kind: "login" }, user);
  expect(nativeText(wire.key).startsWith("7.")).toBe(true);
  const item = openBitwardenWrappedKey(nativeText(wire.key), user, "item");
  expect(
    bitwardenCborMap(
      open(nativeText(wire.data), item.material).model.get("content"),
    ).get("notes"),
  ).toBe(edit.notes);
  expect(readBitwardenBlobItem({ ...wire, id: ID }, user).secret).toBe(
    edit.secret,
  );
  item.material.fill(0);
});
it("changes only notes when optional username, URI and fields are omitted", () => {
  const wire = fixture(model());
  const prior = readBitwardenBlobItem(wire, key());
  const updated = updateBitwardenBlobItem(
    wire,
    { name: prior.name, notes: "Only note changed", secret: prior.secret },
    key(),
  );
  const before = bitwardenCborMap(
    open(nativeText(wire.data)).model.get("content"),
  );
  const after = bitwardenCborMap(
    open(nativeText(updated.data)).model.get("content"),
  );
  for (const property of [
    "typeData",
    "fields",
    "passwordHistory",
    "futureContent",
  ])
    expect(after.get(property)).toEqual(before.get(property));
});
it("never downgrades invalid blobs to accessible legacy fields and enforces matching outer item type", () => {
  const wire = fixture(model());
  wire.name = "legacy fallback bait";
  wire.data = "invalid blob";
  expect(() => readBitwardenBlobItem(wire, key())).toThrow();
  const wrong = fixture(model());
  wrong.type = 2;
  expect(() => readBitwardenBlobItem(wrong, key())).toThrow();
});
it("preserves duplicate unmentioned fields and refuses an ambiguous requested edit", () => {
  const original = model();
  const content = bitwardenCborMap(original.get("content"));
  const fields = content.get("fields");
  if (!Array.isArray(fields)) throw new Error("Expected fields.");
  fields.push(
    map([
      ["name", "Retained"],
      ["value", "duplicate"],
      ["type", 1],
    ]),
  );
  const wire = fixture(original);
  const updated = updateBitwardenBlobItem(wire, edit, key());
  const after = bitwardenCborMap(
    open(nativeText(updated.data)).model.get("content"),
  ).get("fields");
  if (!Array.isArray(after)) throw new Error("Expected fields.");
  expect(after.slice(1)).toEqual(fields.slice(1));
  expect(() =>
    updateBitwardenBlobItem(
      wire,
      { ...edit, fields: { Retained: "ambiguous" } },
      key(),
    ),
  ).toThrow(/multiple/);
});
