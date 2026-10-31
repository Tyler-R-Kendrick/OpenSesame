import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_BITWARDEN_ACCOUNT_KEY_BYTES,
  MAX_BITWARDEN_FIELD_BYTES,
  openBitwardenAccountKeyEnvelope,
  openBitwardenEncString,
  sealBitwardenEncString,
} from "./bitwarden-native-envelope.js";

const key = Uint8Array.from({ length: 64 }, (_, index) => index + 7);
const master = Uint8Array.from({ length: 32 }, (_, index) => index + 103);
const iv = Buffer.alloc(16);
const failure = "Bitwarden ciphertext could not be opened.";
const sample = new TextEncoder().encode("synthetic 🔐 note\u0000\u00ff");
const bytes = (size: number) =>
  Uint8Array.from({ length: size }, (_, index) => (index * 37) % 256);

afterEach(() => vi.restoreAllMocks());

function nodeMac(
  ciphertext: Uint8Array,
  nonce = iv,
  ownKey: Uint8Array = key,
): Buffer {
  return createHmac("sha256", ownKey.slice(32))
    .update(nonce)
    .update(ciphertext)
    .digest();
}

function nodeSeal(
  plaintext: Uint8Array,
  ownKey: Uint8Array = key,
  legacy = false,
): string {
  const cipher = createCipheriv("aes-256-cbc", ownKey.slice(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const fields = [iv.toString("base64"), ciphertext.toString("base64")];
  if (!legacy) fields.push(nodeMac(ciphertext, iv, ownKey).toString("base64"));
  return `${legacy ? 0 : 2}.${fields.join("|")}`;
}

function nodeOpen(text: string, ownKey = key): Uint8Array {
  expect(text.startsWith("2.")).toBe(true);
  const encoded = text.slice(2).split("|");
  expect(encoded).toHaveLength(3);
  const [nonce, ciphertext, mac] = encoded.map((part) =>
    Buffer.from(part, "base64"),
  );
  for (const [index, part] of [nonce, ciphertext, mac].entries())
    expect(part.toString("base64")).toBe(encoded[index]);
  expect(nonce).toHaveLength(16);
  expect(timingSafeEqual(nodeMac(ciphertext, nonce, ownKey), mac)).toBe(true);
  const decipher = createDecipheriv("aes-256-cbc", ownKey.slice(0, 32), nonce);
  return new Uint8Array(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]),
  );
}

function nodeStretch(): Uint8Array {
  return new Uint8Array(
    Buffer.concat(
      ["enc", "mac"].map((info) =>
        createHmac("sha256", master)
          .update(info)
          .update(Buffer.from([1]))
          .digest(),
      ),
    ),
  );
}

it.each([0, 1, 15, 16, 17, 31, 32, 255])(
  "opens independent Node CBC/HMAC ciphertext for %i bytes",
  (size) => {
    const plaintext = bytes(size);
    expect(openBitwardenEncString(nodeSeal(plaintext), key)).toEqual(plaintext);
  },
);

it("roundtrips UTF-8 and binary data through independent Node decryption", () => {
  const before = sample.slice();
  const beforeKey = key.slice();
  expect(openBitwardenEncString(nodeSeal(sample), key)).toEqual(sample);
  const sealed = sealBitwardenEncString(sample, key);
  expect(nodeOpen(sealed)).toEqual(sample);
  expect(openBitwardenEncString(sealed, key)).toEqual(sample);
  expect(sample).toEqual(before);
  expect(key).toEqual(beforeKey);
});

it("also decrypts production CBC output with real WebCrypto", async () => {
  const sealed = sealBitwardenEncString(sample, key);
  expect(nodeOpen(sealed)).toEqual(sample); // Independent MAC authentication first.
  const [nonce, ciphertext] = sealed
    .slice(2)
    .split("|")
    .map((part) => new Uint8Array(Buffer.from(part, "base64")));
  const aes = await crypto.subtle.importKey(
    "raw",
    key.slice(0, 32),
    "AES-CBC",
    false,
    ["decrypt"],
  );
  const opened = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: nonce },
    aes,
    ciphertext,
  );
  expect(new Uint8Array(opened)).toEqual(sample);
});

it("uses fresh cryptographic IVs for repeated writes", () => {
  const first = sealBitwardenEncString(sample, key);
  const second = sealBitwardenEncString(sample, key);
  expect(first.split("|")[0]).not.toBe(second.split("|")[0]);
  expect(nodeOpen(first)).toEqual(sample);
  expect(nodeOpen(second)).toEqual(sample);
});

it.each([0, 1, 2])(
  "rejects a bit flip in IV/ciphertext/MAC part %i",
  (index) => {
    const parts = nodeSeal(sample).slice(2).split("|");
    const corrupt = Buffer.from(parts[index], "base64");
    corrupt[0] ^= 1;
    parts[index] = corrupt.toString("base64");
    expect(() => openBitwardenEncString(`2.${parts.join("|")}`, key)).toThrow(
      failure,
    );
  },
);

it("rejects wrong key and truncation without exposing plaintext or causes", () => {
  const wrongKey = key.slice();
  wrongKey[63] ^= 1;
  for (const [wire, ownKey] of [
    [nodeSeal(sample), wrongKey],
    [nodeSeal(sample).slice(0, -4), key],
  ] as const) {
    let captured: Error | undefined;
    try {
      openBitwardenEncString(wire, ownKey);
    } catch (error) {
      if (error instanceof Error) captured = error;
    }
    expect(captured?.message).toBe(failure);
    expect(captured?.cause).toBeUndefined();
  }
});

it("rejects authentic invalid PKCS7 padding with the same MAC-failure error", () => {
  const cipher = createCipheriv("aes-256-cbc", key.slice(0, 32), iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.alloc(16)),
    cipher.final(),
  ]);
  const tag = nodeMac(ciphertext);
  const encode = () =>
    `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${tag.toString("base64")}`;
  expect(() => openBitwardenEncString(encode(), key)).toThrow(failure);
  tag[0] ^= 1;
  expect(() => openBitwardenEncString(encode(), key)).toThrow(failure);
});

const goodParts = nodeSeal(sample).slice(2).split("|");
const wire = (parts: string[]) => `2.${parts.join("|")}`;
const malformed = [
  "",
  "{}",
  "plaintext",
  `7.${goodParts.join("|")}`,
  `1.${goodParts.join("|")}`,
  `02.${goodParts.join("|")}`,
  `2.${goodParts.join("|")}|extra`,
  wire(goodParts.slice(0, 2)),
  wire(["", goodParts[1], goodParts[2]]),
  wire([goodParts[0], "", goodParts[2]]),
  wire([goodParts[0], goodParts[1], ""]),
  wire([` ${goodParts[0]}`, goodParts[1], goodParts[2]]),
  wire([`${goodParts[0].slice(0, -3)}B==`, goodParts[1], goodParts[2]]),
  wire([goodParts[0].replaceAll("=", ""), goodParts[1], goodParts[2]]),
  wire([
    Buffer.alloc(16, 255).toString("base64url"),
    goodParts[1],
    goodParts[2],
  ]),
  wire([Buffer.alloc(15).toString("base64"), goodParts[1], goodParts[2]]),
  wire([Buffer.alloc(17).toString("base64"), goodParts[1], goodParts[2]]),
  wire([goodParts[0], Buffer.alloc(15).toString("base64"), goodParts[2]]),
  wire([goodParts[0], goodParts[1], Buffer.alloc(31).toString("base64")]),
  wire([goodParts[0], goodParts[1], Buffer.alloc(33).toString("base64")]),
  wire([goodParts[0], goodParts[1], goodParts[2].slice(0, -1)]),
  wire([goodParts[0], "====", goodParts[2]]),
  wire([goodParts[0], `${goodParts[1]}\n`, goodParts[2]]),
];

it.each(malformed)("strictly rejects malformed wire case %#", (text) => {
  expect(() => openBitwardenEncString(text, key)).toThrow(failure);
});

it.each([0, 32, 63, 65])(
  "rejects field-key length %i for reading and writing",
  (size) => {
    const ownKey = new Uint8Array(size);
    expect(() => openBitwardenEncString(nodeSeal(sample), ownKey)).toThrow(
      failure,
    );
    expect(() => sealBitwardenEncString(sample, ownKey)).toThrow(
      "could not be sealed",
    );
  },
);

it("rejects encoded size overrun before permissive base64 fallback", () => {
  const atob = vi.spyOn(globalThis, "atob");
  const tooMuch = "?".repeat(
    Math.ceil((MAX_BITWARDEN_FIELD_BYTES + 16) / 3) * 4 + 4,
  );
  expect(() =>
    openBitwardenEncString(wire([goodParts[0], tooMuch, goodParts[2]]), key),
  ).toThrow(failure);
  expect(() =>
    openBitwardenEncString(
      wire(["?".repeat(28), goodParts[1], goodParts[2]]),
      key,
    ),
  ).toThrow(failure);
  expect(atob).not.toHaveBeenCalled();
});

it("accepts the field ceiling and rejects excess plaintext even with a valid MAC", () => {
  const plaintext = new Uint8Array(MAX_BITWARDEN_FIELD_BYTES).fill(13);
  const sealed = sealBitwardenEncString(plaintext, key);
  expect(Buffer.from(nodeOpen(sealed)).equals(plaintext)).toBe(true);
  expect(
    Buffer.from(openBitwardenEncString(sealed, key)).equals(plaintext),
  ).toBe(true);
  const excess = new Uint8Array(MAX_BITWARDEN_FIELD_BYTES + 1).fill(13);
  expect(() => openBitwardenEncString(nodeSeal(excess), key)).toThrow(failure);
  const randomness = vi.spyOn(crypto, "getRandomValues");
  expect(() => sealBitwardenEncString(excess, key)).toThrow(
    "could not be sealed",
  );
  expect(randomness).not.toHaveBeenCalled();
});

it.each([32, 64, 65, 113, MAX_BITWARDEN_ACCOUNT_KEY_BYTES])(
  "returns complete %i-byte wrapped account keys with both supported envelopes",
  (size) => {
    const plaintext = bytes(size);
    const before = master.slice();
    const authenticated = nodeSeal(plaintext, nodeStretch());
    const legacy = nodeSeal(plaintext, master, true);
    expect(openBitwardenAccountKeyEnvelope(authenticated, master)).toEqual(
      plaintext,
    );
    expect(openBitwardenAccountKeyEnvelope(legacy, master)).toEqual(plaintext);
    expect(() => openBitwardenEncString(legacy, key)).toThrow(failure);
    expect(master).toEqual(before);
  },
);

it("enforces the smaller account envelope size without assuming raw64", () => {
  const excess = bytes(MAX_BITWARDEN_ACCOUNT_KEY_BYTES + 1);
  expect(() =>
    openBitwardenAccountKeyEnvelope(nodeSeal(excess, nodeStretch()), master),
  ).toThrow(failure);
  expect(() =>
    openBitwardenAccountKeyEnvelope(nodeSeal(excess, master, true), master),
  ).toThrow(failure);
  // The same opaque bytes fit the independent, larger field limit.
  expect(openBitwardenEncString(nodeSeal(excess), key)).toEqual(excess);
});

it("rejects malformed legacy account envelopes and invalid master lengths", () => {
  const legacy = nodeSeal(bytes(64), master, true);
  for (const invalid of [
    `${legacy}|extra`,
    legacy.slice(0, -1),
    legacy.replace("0.", "7."),
  ])
    expect(() => openBitwardenAccountKeyEnvelope(invalid, master)).toThrow(
      failure,
    );
  for (const length of [0, 31, 33, 64])
    expect(() =>
      openBitwardenAccountKeyEnvelope(legacy, new Uint8Array(length)),
    ).toThrow(failure);
  const cipher = createCipheriv("aes-256-cbc", master, iv);
  cipher.setAutoPadding(false);
  const invalidPadding = Buffer.concat([
    cipher.update(Buffer.alloc(16)),
    cipher.final(),
  ]);
  expect(() =>
    openBitwardenAccountKeyEnvelope(
      `0.${iv.toString("base64")}|${invalidPadding.toString("base64")}`,
      master,
    ),
  ).toThrow(failure);
});
