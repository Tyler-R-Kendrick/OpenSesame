import {
  createCipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BitwardenCryptoError,
  accessTokenKey,
  base64Bytes,
  boundedKdf,
  bytesBase64,
  decryptBytes,
  decryptText,
  encryptBytes,
  hkdfExpand,
  loginHash,
  masterKey,
  stretchMasterKey,
  symmetricKey,
} from "./native-bitwarden-crypto.js";

const text = (value: string) => new TextEncoder().encode(value);
const key = () => symmetricKey(randomBytes(64));

/** An EncString written by Node's own crypto, so these tests do not check the code against itself. */
function nodeEncrypt(plain: string, k: { enc: Uint8Array; mac: Uint8Array }) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", k.enc, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const mac = createHmac("sha256", k.mac).update(iv).update(body).digest();
  return `2.${iv.toString("base64")}|${body.toString("base64")}|${mac.toString("base64")}`;
}

describe("the EncString envelope", () => {
  it("opens what Node's AES-CBC and HMAC wrote", async () => {
    const k = key();
    expect(await decryptText(nodeEncrypt("hunter2 — ünïcode", k), k)).toBe(
      "hunter2 — ünïcode",
    );
  });

  it("writes what Node's AES-CBC and HMAC can verify and open", async () => {
    const k = key();
    const sealed = await encryptBytes(text("a secret value"), k);
    const [, iv, body, mac] = /^2\.(.*)\|(.*)\|(.*)$/.exec(sealed) ?? [];
    const expected = createHmac("sha256", k.mac)
      .update(Buffer.from(iv ?? "", "base64"))
      .update(Buffer.from(body ?? "", "base64"))
      .digest("base64");
    expect(mac).toBe(expected);
    expect(await decryptText(sealed, k)).toBe("a secret value");
  });

  it("refuses a tampered envelope, a wrong key and a malformed one, and says nothing about which", async () => {
    const k = key();
    const sealed = await encryptBytes(text("value"), k);
    const [, iv, body, mac] = /^2\.(.*)\|(.*)\|(.*)$/.exec(sealed) ?? [];
    const flipped = Buffer.from(body ?? "", "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    for (const bad of [
      `2.${iv}|${flipped.toString("base64")}|${mac}`,
      `2.${iv}|${body}|${Buffer.alloc(32).toString("base64")}`,
      "0.abc|def",
      "2.only-one-part",
      `2.${iv}|${body}`,
      `2.${Buffer.alloc(8).toString("base64")}|${body}|${mac}`,
      `2.${iv}|${Buffer.alloc(5).toString("base64")}|${mac}`,
      "",
    ])
      await expect(decryptBytes(bad, k)).rejects.toBeInstanceOf(
        BitwardenCryptoError,
      );
    await expect(decryptBytes(sealed, key())).rejects.toBeInstanceOf(
      BitwardenCryptoError,
    );
  });

  it("refuses plaintext that is not UTF-8 as text", async () => {
    const k = key();
    const sealed = await encryptBytes(Uint8Array.of(0xff, 0xfe, 0xfd), k);
    await expect(decryptText(sealed, k)).rejects.toBeInstanceOf(
      BitwardenCryptoError,
    );
  });
});

describe("keys", () => {
  it("expands like RFC 5869 HKDF-Expand: T(1) = HMAC(prk, info | 0x01), T(n) chains the block before it", async () => {
    const prk = randomBytes(32);
    const t1 = createHmac("sha256", prk)
      .update(Buffer.concat([Buffer.from("x"), Buffer.of(1)]))
      .digest();
    const t2 = createHmac("sha256", prk)
      .update(Buffer.concat([t1, Buffer.from("x"), Buffer.of(2)]))
      .digest();
    expect(Buffer.from(await hkdfExpand(prk, text("x"), 32))).toEqual(t1);
    expect(Buffer.from(await hkdfExpand(prk, text("x"), 64))).toEqual(
      Buffer.concat([t1, t2]),
    );
    expect((await hkdfExpand(prk, text(""), 17)).length).toBe(17);
    await expect(hkdfExpand(prk, text("x"), 0)).rejects.toBeInstanceOf(
      BitwardenCryptoError,
    );
  });

  it("stretches a master key into the encryption and MAC keys Bitwarden uses", async () => {
    const master = randomBytes(32);
    const stretched = await stretchMasterKey(master);
    expect(Buffer.from(stretched.enc)).toEqual(
      createHmac("sha256", master)
        .update(Buffer.concat([Buffer.from("enc"), Buffer.of(1)]))
        .digest(),
    );
    expect(Buffer.from(stretched.mac)).toEqual(
      createHmac("sha256", master)
        .update(Buffer.concat([Buffer.from("mac"), Buffer.of(1)]))
        .digest(),
    );
    await expect(stretchMasterKey(randomBytes(31))).rejects.toBeInstanceOf(
      BitwardenCryptoError,
    );
  });

  it("derives the Secrets Manager access-token key from its 16 bytes", async () => {
    const secret = randomBytes(16);
    const derived = await accessTokenKey(secret);
    const prk = createHmac("sha256", "bitwarden-accesstoken")
      .update(secret)
      .digest();
    const t1 = createHmac("sha256", prk)
      .update(Buffer.concat([Buffer.from("sm-access-token"), Buffer.of(1)]))
      .digest();
    const t2 = createHmac("sha256", prk)
      .update(Buffer.concat([t1, Buffer.from("sm-access-token"), Buffer.of(2)]))
      .digest();
    expect(Buffer.from(derived.enc)).toEqual(t1);
    expect(Buffer.from(derived.mac)).toEqual(t2);
    await expect(accessTokenKey(randomBytes(15))).rejects.toBeInstanceOf(
      BitwardenCryptoError,
    );
  });

  it("derives the PBKDF2 master key and login hash from the password's raw UTF-8 bytes, as Bitwarden's clients do (only the email is trimmed and lower-cased)", async () => {
    const master = await masterKey("Pässword 1", " Me@Example.COM ", {
      kind: "pbkdf2",
      iterations: 5000,
    });
    const expected = pbkdf2Sync(
      "Pässword 1",
      "me@example.com",
      5000,
      32,
      "sha256",
    );
    expect(Buffer.from(master)).toEqual(expected);
    expect(await loginHash(master, "Pässword 1")).toBe(
      pbkdf2Sync(expected, "Pässword 1", 1, 32, "sha256").toString("base64"),
    );
  });

  it("does not normalize the password: a composed and a decomposed spelling are different passwords", async () => {
    const kdf = { kind: "pbkdf2", iterations: 5000 } as const;
    const composed = await masterKey("Pässword", "me@example.com", kdf);
    const decomposed = await masterKey("Pa\u0308ssword", "me@example.com", kdf);
    expect(Buffer.from(composed)).not.toEqual(Buffer.from(decomposed));
    expect(Buffer.from(composed)).toEqual(
      pbkdf2Sync(
        Buffer.from("Pässword", "utf8"),
        "me@example.com",
        5000,
        32,
        "sha256",
      ),
    );
  });

  it("derives an Argon2id master key within the bounds an account honestly has", async () => {
    const kdf = {
      kind: "argon2id",
      iterations: 2,
      memoryMiB: 16,
      parallelism: 1,
    } as const;
    const a = await masterKey("password", "me@example.com", kdf);
    const b = await masterKey("password", "me@example.com", kdf);
    const c = await masterKey("password", "other@example.com", kdf);
    expect(a.length).toBe(32);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
    expect(Buffer.from(a)).not.toEqual(Buffer.from(c));
  });

  it("will not run a KDF with parameters outside any honest account's", () => {
    for (const kdf of [
      { kind: "pbkdf2", iterations: 1 },
      { kind: "pbkdf2", iterations: 2_000_001 },
      { kind: "pbkdf2", iterations: 600000.5 },
      { kind: "argon2id", iterations: 1, memoryMiB: 64, parallelism: 4 },
      { kind: "argon2id", iterations: 3, memoryMiB: 4096, parallelism: 4 },
      { kind: "argon2id", iterations: 3, memoryMiB: 64, parallelism: 99 },
    ] as const)
      expect(() => boundedKdf(kdf)).toThrow(BitwardenCryptoError);
    expect(boundedKdf({ kind: "pbkdf2", iterations: 600000 })).toEqual({
      kind: "pbkdf2",
      iterations: 600000,
    });
  });
});

describe("base64", () => {
  it("reads standard and URL-safe, padded or not, and nothing else", () => {
    expect(bytesBase64(base64Bytes("AQID"))).toBe("AQID");
    expect(Array.from(base64Bytes("-_8"))).toEqual([251, 255]);
    expect(Array.from(base64Bytes("+/8="))).toEqual([251, 255]);
    expect(() => base64Bytes("not base64!")).toThrow(BitwardenCryptoError);
  });
});

/** Fixed outputs independently matched by RustCrypto Argon2 0.5.3 and Noble 2.4.0, version 0x13. */
const argonKnownAnswers = [
  {
    id: "production-unicode-nul",
    password: "KAT 密碼 café\u0000🔐",
    email: "  Owner@Example.TEST\t",
    memoryMiB: 64,
    iterations: 3,
    parallelism: 4,
    expectedMasterKeyHex:
      "ba0418962313c94bf87128080c2048b8f54d03a9129c3afd3d911497d294ed73",
  },
  {
    id: "minimum",
    password: "minimum synthetic fixture password",
    email: "min@example.test",
    memoryMiB: 16,
    iterations: 2,
    parallelism: 1,
    expectedMasterKeyHex:
      "fc07750ee40de3bf6d9d19ad284bf63f92d062532e4176e9d0a0e2e7037c65af",
  },
  {
    id: "normalized-unicode-email",
    password: "email-only normalization: Ωé",
    email: "  ÉLÈVE@DÖMÄIN.EXAMPLE \t",
    memoryMiB: 16,
    iterations: 2,
    parallelism: 4,
    expectedMasterKeyHex:
      "3915446f797c9dfabe1a821286c719dcf5aac7147a29a6e05ab81351f1d7324e",
  },
  {
    id: "parallel-a",
    password: "independent A\u0000Å",
    email: "parallel-a@example.test",
    memoryMiB: 16,
    iterations: 2,
    parallelism: 2,
    expectedMasterKeyHex:
      "358e703a5839b10630f6ba08ecf68c6304c3c4a8a54ff4bb26e7ac234c18cb62",
  },
  {
    id: "parallel-b",
    password: "independent B café",
    email: "parallel-b@example.test",
    memoryMiB: 16,
    iterations: 2,
    parallelism: 2,
    expectedMasterKeyHex:
      "8783d6744d4ae74b14ff1c827928d6cb5165bef8898ecc74897b93c32b8aa3cd",
  },
] as const;

it.each(argonKnownAnswers)(
  "matches the independent Argon2id known answer: $id",
  async ({
    password,
    email,
    memoryMiB,
    iterations,
    parallelism,
    expectedMasterKeyHex,
  }) => {
    const result = await masterKey(password, email, {
      kind: "argon2id",
      memoryMiB,
      iterations,
      parallelism,
    });
    expect(Buffer.from(result).toString("hex")).toBe(expectedMasterKeyHex);
  },
);

it("keeps concurrent Argon2id results independent and caller-owned", async () => {
  const pair = argonKnownAnswers.slice(-2);
  const derive = (row: (typeof argonKnownAnswers)[number]) =>
    masterKey(row.password, row.email, {
      kind: "argon2id",
      memoryMiB: row.memoryMiB,
      iterations: row.iterations,
      parallelism: row.parallelism,
    });
  const results = await Promise.all(pair.map(derive));
  expect(results.map((result) => Buffer.from(result).toString("hex"))).toEqual(
    pair.map((row) => row.expectedMasterKeyHex),
  );
  results[0]?.fill(0);
  expect(Buffer.from(results[1] ?? []).toString("hex")).toBe(
    pair[1]?.expectedMasterKeyHex,
  );
  const reversed = [...pair].reverse();
  expect(
    (await Promise.all(reversed.map(derive))).map((result) =>
      Buffer.from(result).toString("hex"),
    ),
  ).toEqual(reversed.map((row) => row.expectedMasterKeyHex));
});
