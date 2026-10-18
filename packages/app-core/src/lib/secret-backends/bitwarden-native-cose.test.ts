import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { type CBORType, decodeCBOR, encodeCBOR } from "@levischuck/tiny-cbor";
import { expect, it } from "vitest";
import {
  openBitwardenBlob,
  openBitwardenWrappedKey,
  sealBitwardenBlob,
  sealBitwardenWrappedKey,
} from "./bitwarden-native-blob.js";
import {
  type BitwardenCborMap,
  type BitwardenNativeKey,
  bitwardenCborBytes,
  bitwardenCborMap,
  decodeBitwardenCbor,
  decodeBitwardenKey,
  encodeBitwardenCbor,
  encodeBitwardenKey,
} from "./bitwarden-native-cose.js";

const raw = Uint8Array.from({ length: 64 }, (_, i) => i + 7);
const itemKey = () => decodeBitwardenKey(raw);
const cek = new Uint8Array(32).fill(23);
const kid = new Uint8Array(16).fill(41);
const iv = new Uint8Array(12).fill(17);
const model: BitwardenCborMap = new Map<string | number, CBORType>([
  ["version", "1"],
  [
    "content",
    new Map<string, CBORType>([
      ["name", "synthetic note"],
      ["notes", "private UTF8 🔐"],
      [
        "typeData",
        new Map<string, CBORType>([
          ["type", "secureNote"],
          ["secureNoteType", 0],
        ]),
      ],
      ["futureMember", [new Map([["keep", true]]), new Uint8Array([3, 8])]],
      [
        "fields",
        [
          new Map<string, CBORType>([
            ["name", "retained"],
            ["value", "secret"],
            ["type", 1],
          ]),
        ],
      ],
    ]),
  ],
]);
const failure = "Bitwarden protected data could not be opened.";
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const decode = (value: Uint8Array) => decodeCBOR(new Uint8Array(value));

function pad(value: Uint8Array, minimum: number): Uint8Array {
  const count = Math.max(1, minimum - value.length);
  return new Uint8Array(Buffer.concat([value, Buffer.alloc(count, count)]));
}

function nodeWrap(value: Uint8Array): string {
  const nonce = Buffer.alloc(16, 9);
  const aes = createCipheriv("aes-256-cbc", raw.slice(0, 32), nonce);
  const ciphertext = Buffer.concat([aes.update(value), aes.final()]);
  const tag = createHmac("sha256", raw.slice(32))
    .update(nonce)
    .update(ciphertext)
    .digest();
  return `2.${nonce.toString("base64")}|${ciphertext.toString("base64")}|${tag.toString("base64")}`;
}

function nodeUnwrap(text: string): Uint8Array {
  const [nonce, ciphertext, tag] = text
    .slice(2)
    .split("|")
    .map((part) => Buffer.from(part, "base64"));
  const mac = createHmac("sha256", raw.slice(32))
    .update(nonce)
    .update(ciphertext)
    .digest();
  expect(timingSafeEqual(mac, tag)).toBe(true);
  const aes = createDecipheriv("aes-256-cbc", raw.slice(0, 32), nonce);
  return new Uint8Array(Buffer.concat([aes.update(ciphertext), aes.final()]));
}

function header(): BitwardenCborMap {
  // Deliberately different ordering proves original protected bytes are used as AAD.
  return new Map<string | number, CBORType>([
    [3, "application/x.bitwarden.cbor-padded"],
    [-80001, 1],
    [4, kid],
    [1, 3],
    [-80002, 2],
  ]);
}

function fixture(protectedHeader = header(), operations = [4]): string {
  const encodedKey = pad(
    encodeCBOR(
      new Map<number, CBORType>([
        [1, 4],
        [2, kid],
        [3, 3],
        [4, operations],
        [-1, cek],
      ]),
    ),
    65,
  );
  const protectedBytes = encodeCBOR(protectedHeader);
  const aad = encodeCBOR(["Encrypt0", protectedBytes, new Uint8Array()]);
  const aes = createCipheriv("aes-256-gcm", cek, iv);
  aes.setAAD(aad);
  const ciphertext = Buffer.concat([
    aes.update(pad(encodeCBOR(model), 64)),
    aes.final(),
    aes.getAuthTag(),
  ]);
  const envelope = encodeCBOR([
    protectedBytes,
    new Map([[5, iv]]),
    new Uint8Array(ciphertext),
  ]);
  return JSON.stringify({
    format_version: 1,
    wrapped_cek: nodeWrap(encodedKey),
    envelope: Buffer.from(envelope).toString("base64"),
  });
}

function nodeOpenBlob(text: string) {
  const container = JSON.parse(text);
  const paddedKey = nodeUnwrap(container.wrapped_cek);
  const key = bitwardenCborMap(
    decode(paddedKey.slice(0, -paddedKey[paddedKey.length - 1])),
  );
  expect(key.get(3)).toBe(3);
  expect(key.get(4)).toEqual([4]);
  const encoded = decode(bytes(container.envelope));
  if (!Array.isArray(encoded))
    throw new Error("Expected independent Encrypt0 array.");
  const protectedBytes = bitwardenCborBytes(encoded[0]);
  const parsedHeader = bitwardenCborMap(decode(protectedBytes));
  expect(parsedHeader.get(1)).toBe(3);
  expect(parsedHeader.get(4)).toEqual(key.get(2));
  expect(parsedHeader.get(-80001)).toBe(1);
  expect(parsedHeader.get(-80002)).toBe(2);
  const nonce = bitwardenCborBytes(bitwardenCborMap(encoded[1]).get(5));
  const material = bitwardenCborBytes(key.get(-1));
  const cipher = createDecipheriv("aes-256-gcm", material, nonce);
  cipher.setAAD(encodeCBOR(["Encrypt0", protectedBytes, new Uint8Array()]));
  const ciphertext = bitwardenCborBytes(encoded[2]);
  cipher.setAuthTag(ciphertext.slice(-16));
  const padded = Buffer.concat([
    cipher.update(ciphertext.slice(0, -16)),
    cipher.final(),
  ]);
  return {
    model: decode(padded.slice(0, -padded[padded.length - 1])),
    material,
    nonce,
  };
}

it("reads independent authenticated data with reordered protected headers", () => {
  expect(openBitwardenBlob(fixture(), itemKey())).toEqual(model);
});

it("writes independently decryptable fresh-CEK blobs and preserves unknown members", () => {
  const before = raw.slice();
  const first = sealBitwardenBlob(model, itemKey());
  const second = sealBitwardenBlob(model, itemKey());
  const decoded = nodeOpenBlob(first);
  const another = nodeOpenBlob(second);
  expect(decoded.model).toEqual(model);
  expect(another.model).toEqual(model);
  expect(decoded.material).not.toEqual(another.material);
  expect(decoded.nonce).not.toEqual(another.nonce);
  expect(raw).toEqual(before);
  expect(openBitwardenBlob(first, itemKey())).toEqual(model);
});

it.each([
  [-80001, 2],
  [-80002, 3],
  [1, -70010],
  [3, "application/cbor"],
  [4, new Uint8Array(16)],
])("rejects authentic wrong protected context label %i", (label, value) => {
  const changed = header();
  changed.set(label, value);
  expect(() => openBitwardenBlob(fixture(changed), itemKey())).toThrow(failure);
});

it("rejects unknown/missing/self-referencing critical headers even with valid tags", () => {
  for (const labels of [[999], [2], [1, 1]]) {
    const changed = header();
    changed.set(2, labels);
    expect(() => openBitwardenBlob(fixture(changed), itemKey())).toThrow(
      failure,
    );
  }
  const understood = header();
  understood.set(2, [1, 3, 4, -80001, -80002]);
  expect(openBitwardenBlob(fixture(understood), itemKey())).toEqual(model);
});

it("rejects a persisted CEK with encryption/wrapping permission", () => {
  expect(() => openBitwardenBlob(fixture(header(), [3, 4]), itemKey())).toThrow(
    failure,
  );
});

it("rejects corruption and never falls back to legacy empty fields", () => {
  const container = JSON.parse(fixture());
  const encoded = bytes(container.envelope);
  encoded[encoded.length - 1] ^= 1;
  container.envelope = Buffer.from(encoded).toString("base64");
  expect(() => openBitwardenBlob(JSON.stringify(container), itemKey())).toThrow(
    failure,
  );
  expect(() => openBitwardenBlob("{}", itemKey())).toThrow(failure);
  container.format_version = 2;
  expect(() => openBitwardenBlob(JSON.stringify(container), itemKey())).toThrow(
    failure,
  );
});

it("retains exact legacy keys and derives the RFC9679 key ID independently", () => {
  const key = itemKey();
  const encodedRequired = Buffer.concat([
    Buffer.from([0xa2, 1, 4, 0x20, 0x58, 0x40]),
    raw,
  ]);
  expect(key.id).toEqual(
    new Uint8Array(
      createHash("sha256").update(encodedRequired).digest().subarray(0, 16),
    ),
  );
  expect(encodeBitwardenKey(key)).toEqual(raw);
  expect(decodeBitwardenKey(new Uint8Array(32)).operations).toEqual([4]);
});

it("roundtrips wrapped raw64 and padded COSE keys through typed XAES contexts", () => {
  const xaes: BitwardenNativeKey = {
    algorithm: -70010,
    material: cek.slice(),
    id: kid.slice(),
    operations: [3, 4, 5, 6],
  };
  const wrapped = sealBitwardenWrappedKey(itemKey(), xaes);
  expect(wrapped.startsWith("7.")).toBe(true);
  expect(openBitwardenWrappedKey(wrapped, xaes, "item").material).toEqual(raw);
  const encrypted = sealBitwardenWrappedKey(xaes, itemKey());
  const opened = openBitwardenWrappedKey(encrypted, itemKey(), "item");
  expect(opened).toEqual(xaes);
  expect(() => openBitwardenWrappedKey(encrypted, itemKey(), "cek")).toThrow(
    failure,
  );
  expect(() => openBitwardenBlob(fixture(), xaes)).toThrow(failure);
});

it("enforces key operation and cipher algorithm separation", () => {
  const readonly = itemKey();
  readonly.operations = [4];
  expect(() => sealBitwardenBlob(model, readonly)).toThrow(
    "could not be sealed",
  );
  expect(() => openBitwardenBlob(fixture(), readonly)).toThrow(failure);
  const legacy = decodeBitwardenKey(new Uint8Array(32));
  expect(() => sealBitwardenBlob(model, legacy)).toThrow("could not be sealed");
});

it.each([
  new Uint8Array([0xa2, 1, 2, 1, 3]),
  new Uint8Array([0x9f, 0xff]),
  new Uint8Array([0xc0, 1]),
  new Uint8Array([0x61, 0xff]),
  new Uint8Array([0x99, 0x10, 1]),
  new Uint8Array([1, 2]),
  new Uint8Array([0x1b, 0, 0x20, 0, 0, 0, 0, 0, 0]),
  new Uint8Array([0xf9, 0x7c, 0]),
])(
  "rejects duplicate/indefinite/deep/invalid scalar CBOR case %#",
  (encoded) => {
    expect(() => decodeBitwardenCbor(encoded, 4096)).toThrow(
      "Invalid Bitwarden",
    );
  },
);

it("bounds resource/depth/cycles before mature codec work", () => {
  const deep = new Uint8Array([...new Uint8Array(17).fill(0x81), 0]);
  expect(() => decodeBitwardenCbor(deep, 4096)).toThrow();
  expect(() => decodeBitwardenCbor(new Uint8Array(1025), 1024)).toThrow();
  const cycle: CBORType[] = [];
  cycle.push(cycle);
  expect(() => encodeBitwardenCbor(cycle, 4096)).toThrow();
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
    expect(() => encodeBitwardenCbor(invalid, 4096)).toThrow();
});

it("copies offset input views before decoding and keeps caller bytes intact", () => {
  const encoded = encodeCBOR(model);
  const backing = new Uint8Array(encoded.length + 6).fill(255);
  backing.set(encoded, 3);
  expect(decodeBitwardenCbor(backing.subarray(3, -3), 4096)).toEqual(model);
  expect(backing.subarray(0, 3)).toEqual(new Uint8Array(3).fill(255));
});

it("accepts exact encoded-byte ceilings and rejects the first excess byte", () => {
  const value = new Uint8Array(1021).fill(7);
  const encoded = encodeBitwardenCbor(value, 1024);
  expect(encoded).toHaveLength(1024);
  expect(decodeBitwardenCbor(encoded, 1024)).toEqual(value);
  expect(() => encodeBitwardenCbor(new Uint8Array(1022), 1024)).toThrow();
  expect(() =>
    decodeBitwardenCbor(encodeCBOR(new Uint8Array(1022)), 1024),
  ).toThrow();
  const deepest = new Uint8Array([...new Uint8Array(16).fill(0x81), 0]);
  expect(() => decodeBitwardenCbor(deepest, 1024)).not.toThrow();
});

it("rejects altered key padding, key algorithms, IDs and operation sets", () => {
  const values: BitwardenCborMap = new Map<number, CBORType>([
    [1, 4],
    [2, kid],
    [3, 3],
    [4, [4]],
    [-1, cek],
  ]);
  const corrupt = pad(encodeCBOR(values), 65);
  corrupt[corrupt.length - 2] ^= 1;
  expect(() => decodeBitwardenKey(corrupt)).toThrow();
  for (const [label, value] of [
    [3, 999],
    [2, new Uint8Array(15)],
    [4, [4, 4].slice()],
    [-1, new Uint8Array(31)],
  ] as const) {
    const changed = new Map(values);
    changed.set(label, value);
    expect(() => decodeBitwardenKey(pad(encodeCBOR(changed), 65))).toThrow();
  }
});
