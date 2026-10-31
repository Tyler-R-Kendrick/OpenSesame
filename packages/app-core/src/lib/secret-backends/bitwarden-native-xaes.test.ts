import { createCipheriv, createDecipheriv } from "node:crypto";
import { expect, it } from "vitest";
import {
  MAX_BITWARDEN_XAES_AAD_BYTES,
  MAX_BITWARDEN_XAES_PLAINTEXT_BYTES,
  openBitwardenXaes,
  sealBitwardenXaes,
} from "./bitwarden-native-xaes.js";
import { asBufferSource } from "@opensesame/os-domain";

const keyFor = (seed: number) =>
  Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + seed) & 255);
const nonce = Uint8Array.from(
  { length: 24 },
  (_, index) => (index * 7 + 31) & 255,
);
const plaintext = new TextEncoder().encode("browser-only V2 🔐\0");
const aad = new TextEncoder().encode("synthetic protected header\0");
const failure = "Bitwarden XAES ciphertext could not be opened.";

function nodeBlock(key: Uint8Array, input: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

/** Independent bigint CMAC arithmetic and Node/OpenSSL AES implementation. */
function nodeSubkey(key: Uint8Array, ownNonce = nonce): Buffer {
  const l = nodeBlock(key, new Uint8Array(16));
  const integer = BigInt(`0x${l.toString("hex")}`);
  const shifted = (integer << 1n) & ((1n << 128n) - 1n);
  const mask = shifted ^ (integer >> 127n ? 0x87n : 0n);
  return Buffer.concat(
    [1, 2].map((counter) => {
      const message = Buffer.concat([
        Buffer.from([0, counter, 0x58, 0]),
        ownNonce.slice(0, 12),
      ]);
      const mixed = BigInt(`0x${message.toString("hex")}`) ^ mask;
      return nodeBlock(
        key,
        Buffer.from(mixed.toString(16).padStart(32, "0"), "hex"),
      );
    }),
  );
}

function nodeSeal(
  body: Uint8Array,
  key: Uint8Array,
  ownNonce = nonce,
  ownAad = aad,
): Uint8Array {
  const cipher = createCipheriv(
    "aes-256-gcm",
    nodeSubkey(key, ownNonce),
    ownNonce.slice(12),
  );
  cipher.setAAD(ownAad);
  return new Uint8Array(
    Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]),
  );
}

function nodeOpen(
  body: Uint8Array,
  key: Uint8Array,
  ownNonce = nonce,
  ownAad = aad,
): Uint8Array {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    nodeSubkey(key, ownNonce),
    ownNonce.slice(12),
  );
  cipher.setAAD(ownAad);
  cipher.setAuthTag(body.slice(-16));
  return new Uint8Array(
    Buffer.concat([cipher.update(body.slice(0, -16)), cipher.final()]),
  );
}

it.each([
  [
    2,
    1,
    "8aac13b6b84196ad39521eb3fee31ec118dfc8492a9ac3406ea8d0534c6d0d242da87760f1",
  ],
  [
    7,
    0,
    "ac77a63dd4392b9ca920d103bed72d52ae38e3ed34cfa269d531f70b8071dff9ea5bdde774",
  ],
])(
  "matches independent known answer seed %i / CMAC high bit %i",
  (seed, bit, expected) => {
    const key = keyFor(seed);
    expect(nodeBlock(key, new Uint8Array(16))[0] >>> 7).toBe(bit);
    const encrypted = sealBitwardenXaes(plaintext, key, nonce, aad);
    expect(Buffer.from(nodeSeal(plaintext, key)).toString("hex")).toBe(
      expected,
    );
    expect(Buffer.from(encrypted).toString("hex")).toBe(expected);
    expect(openBitwardenXaes(encrypted, key, nonce, aad)).toEqual(plaintext);
    expect(nodeOpen(encrypted, key)).toEqual(plaintext);
  },
);

it.each([0, 1, 15, 16, 17, 255, 1024])(
  "interoperates for %i-byte plaintext",
  (size) => {
    const key = keyFor(12);
    const body = Uint8Array.from({ length: size }, (_, index) => index & 255);
    const encoded = sealBitwardenXaes(body, key, nonce, aad);
    expect(nodeOpen(encoded, key)).toEqual(body);
    expect(openBitwardenXaes(nodeSeal(body, key), key, nonce, aad)).toEqual(
      body,
    );
    expect(encoded.length).toBe(size + 16);
  },
);

it("interoperates with actual WebCrypto GCM using an independent derived key", async () => {
  const key = keyFor(19);
  const encoded = sealBitwardenXaes(plaintext, key, nonce, aad);
  const aes = await crypto.subtle.importKey(
    "raw",
    asBufferSource(nodeSubkey(key)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce.slice(12),
      additionalData: aad,
      tagLength: 128,
    },
    aes,
    asBufferSource(encoded),
  );
  expect(new Uint8Array(opened)).toEqual(plaintext);
});

it.each([0, plaintext.length, plaintext.length + 15])(
  "rejects a ciphertext/tag flip at %i",
  (index) => {
    const key = keyFor(7);
    const encoded = sealBitwardenXaes(plaintext, key, nonce, aad);
    encoded[index] ^= 1;
    expect(() => openBitwardenXaes(encoded, key, nonce, aad)).toThrow(failure);
  },
);

it.each([0, 11, 12, 23])(
  "authenticates nonce byte %i in both halves",
  (index) => {
    const key = keyFor(7);
    const encoded = sealBitwardenXaes(plaintext, key, nonce, aad);
    const wrongNonce = nonce.slice();
    wrongNonce[index] ^= 1;
    expect(() => openBitwardenXaes(encoded, key, wrongNonce, aad)).toThrow(
      failure,
    );
  },
);

it("rejects wrong key, modified AAD and truncated tags without causes", () => {
  const key = keyFor(7);
  const encoded = sealBitwardenXaes(plaintext, key, nonce, aad);
  const wrongAad = aad.slice();
  wrongAad[0] ^= 1;
  expect(() => openBitwardenXaes(encoded, keyFor(2), nonce, aad)).toThrow(
    failure,
  );
  expect(() => openBitwardenXaes(encoded, key, nonce, wrongAad)).toThrow(
    failure,
  );
  expect(() =>
    openBitwardenXaes(encoded.slice(0, -1), key, nonce, aad),
  ).toThrow(failure);
  try {
    openBitwardenXaes(encoded, keyFor(2), nonce, aad);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe(failure);
      expect(error.cause).toBeUndefined();
    }
  }
});

it("does not accept ordinary GCM under the original key and truncated nonce", () => {
  const key = keyFor(7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce.slice(12));
  cipher.setAAD(aad);
  const ordinary = new Uint8Array(
    Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  );
  expect(() => openBitwardenXaes(ordinary, key, nonce, aad)).toThrow(failure);
});

it.each([0, 16, 31, 33, 64])("rejects key length %i", (size) => {
  const key = new Uint8Array(size);
  expect(() => sealBitwardenXaes(plaintext, key, nonce, aad)).toThrow(
    "could not be sealed",
  );
  expect(() => openBitwardenXaes(new Uint8Array(16), key, nonce, aad)).toThrow(
    failure,
  );
});

it.each([0, 12, 23, 25])(
  "rejects nonce length %i rather than truncating it",
  (size) => {
    const ownNonce = new Uint8Array(size);
    expect(() =>
      sealBitwardenXaes(plaintext, keyFor(7), ownNonce, aad),
    ).toThrow("could not be sealed");
    expect(() =>
      openBitwardenXaes(new Uint8Array(16), keyFor(7), ownNonce, aad),
    ).toThrow(failure);
  },
);

it.each([0, 1, 15])(
  "rejects ciphertext shorter than tag16 (%i bytes)",
  (size) => {
    expect(() =>
      openBitwardenXaes(new Uint8Array(size), keyFor(7), nonce, aad),
    ).toThrow(failure);
  },
);

it("preserves caller-owned buffers and returns independent bytes", () => {
  const key = keyFor(7);
  const before = [plaintext.slice(), key.slice(), nonce.slice(), aad.slice()];
  const sealed = sealBitwardenXaes(plaintext, key, nonce, aad);
  const sealedBefore = sealed.slice();
  const opened = openBitwardenXaes(sealed, key, nonce, aad);
  opened.fill(0);
  expect([plaintext, key, nonce, aad]).toEqual(before);
  expect(sealed).toEqual(sealedBefore);
});

it("uses only the selected bytes of offset views from decoded envelopes", () => {
  const view = (value: Uint8Array) => {
    const backing = new Uint8Array(value.length + 6).fill(255);
    backing.set(value, 3);
    return backing.subarray(3, -3);
  };
  const key = keyFor(7);
  const encoded = sealBitwardenXaes(
    view(plaintext),
    view(key),
    view(nonce),
    view(aad),
  );
  expect(encoded).toEqual(nodeSeal(plaintext, key));
  expect(
    openBitwardenXaes(view(encoded), view(key), view(nonce), view(aad)),
  ).toEqual(plaintext);
});

it("supports empty AAD but authenticates its exact bytes", () => {
  const empty = new Uint8Array();
  const encoded = sealBitwardenXaes(plaintext, keyFor(7), nonce, empty);
  expect(nodeOpen(encoded, keyFor(7), nonce, empty)).toEqual(plaintext);
  expect(() => openBitwardenXaes(encoded, keyFor(7), nonce, aad)).toThrow(
    failure,
  );
});

it("enforces exact plaintext and AAD allocation ceilings", () => {
  const key = keyFor(7);
  const maximum = new Uint8Array(MAX_BITWARDEN_XAES_PLAINTEXT_BYTES).fill(27);
  const header = new Uint8Array(MAX_BITWARDEN_XAES_AAD_BYTES).fill(3);
  const encoded = sealBitwardenXaes(maximum, key, nonce, header);
  expect(
    Buffer.from(nodeOpen(encoded, key, nonce, header)).equals(maximum),
  ).toBe(true);
  expect(
    Buffer.from(openBitwardenXaes(encoded, key, nonce, header)).equals(maximum),
  ).toBe(true);
  expect(() =>
    sealBitwardenXaes(new Uint8Array(maximum.length + 1), key, nonce, header),
  ).toThrow("could not be sealed");
  expect(() =>
    openBitwardenXaes(new Uint8Array(encoded.length + 1), key, nonce, header),
  ).toThrow(failure);
  expect(() =>
    sealBitwardenXaes(plaintext, key, nonce, new Uint8Array(header.length + 1)),
  ).toThrow("could not be sealed");
  expect(() =>
    openBitwardenXaes(encoded, key, nonce, new Uint8Array(header.length + 1)),
  ).toThrow(failure);
});
