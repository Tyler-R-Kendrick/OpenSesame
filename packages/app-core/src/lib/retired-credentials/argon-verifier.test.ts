/** Controlled work-boundary tests; these do not prove actual Argon2 output. */
import { Buffer } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import {
  type RetiredKdfWork,
  createRetiredVerifier,
  equalVerifierBytes,
  passwordBytes,
} from "./argon-verifier.js";
const work = vi.fn<RetiredKdfWork["derive"]>();
const { derive, verify } = createRetiredVerifier({ derive: work });
const salt = () => Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const output = () => new Uint8Array(32).fill(17);
afterEach(() => vi.resetAllMocks());

it("enforces actual UTF8 boundaries without rewriting well-formed passwords", () => {
  for (const text of [
    "a".repeat(4096),
    "é".repeat(2048),
    `${"€".repeat(1365)}a`,
    "😀".repeat(1024),
  ]) {
    const bytes = passwordBytes(text);
    try {
      expect(bytes).toHaveLength(4096);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(
        text,
      );
    } finally {
      bytes.fill(0);
    }
    expect(() => passwordBytes(`${text}a`)).toThrow();
  }
  expect(Array.from(passwordBytes("é"))).not.toEqual(
    Array.from(passwordBytes("e\u0301")),
  );
});

it("rejects empty and ill-formed UTF16 instead of aliasing replacement characters", async () => {
  for (const text of [
    "",
    "\ud800",
    "\udfff",
    "a\ud800b",
    "\ud800\ud800",
    "\udc00\ud800",
  ])
    await expect(derive(text, salt())).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(new TextDecoder().decode(passwordBytes("�"))).toBe("�");
});

it("refuses malformed public salt or verifier before invoking work", async () => {
  for (const length of [0, 15, 17])
    await expect(derive("valid", new Uint8Array(length))).rejects.toThrow();
  for (const length of [0, 31, 33])
    await expect(
      verify("valid", salt(), new Uint8Array(length)),
    ).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});

it("compares every valid position and refuses public length mismatch", () => {
  const expected = output();
  expect(equalVerifierBytes(expected, expected.slice())).toBe(true);
  for (let position = 0; position < 32; position++) {
    const changed = expected.slice();
    changed[position] = 18;
    expect(equalVerifierBytes(expected, changed)).toBe(false);
  }
  expect(equalVerifierBytes(expected, new Uint8Array(31))).toBe(false);
  expect(equalVerifierBytes(expected, new Uint8Array(33))).toBe(false);
});

it("refuses overlapping derive and verify without queued work, then recovers", async () => {
  let finish: ((bytes: Uint8Array) => void) | undefined;
  work.mockImplementationOnce(
    () =>
      new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = derive("first", salt());
  if (!finish) throw new Error("Controlled work did not start.");
  const release = finish;
  try {
    await expect(derive("second", salt())).rejects.toThrow(/already running/);
    await expect(verify("second", salt(), output())).rejects.toThrow(
      /already running/,
    );
    expect(work).toHaveBeenCalledTimes(1);
  } finally {
    release(output());
    await pending;
  }
  work.mockResolvedValueOnce(output());
  await expect(derive("next", salt())).resolves.toBe(
    btoa(String.fromCharCode(...output())),
  );
  expect(work).toHaveBeenCalledTimes(2);
});

it("wipes owned buffers on successful derivation without changing caller salt", async () => {
  const callerSalt = salt();
  const before = callerSalt.slice();
  const derived = output();
  let password: Uint8Array | undefined;
  let ownSalt: Uint8Array | undefined;
  work.mockImplementationOnce(async (encoded, saltBytes) => {
    password = encoded;
    ownSalt = saltBytes;
    expect(password).toEqual(new TextEncoder().encode("selected"));
    expect(ownSalt).toEqual(before);
    return derived;
  });
  const expected = btoa(String.fromCharCode(...derived));
  await expect(derive("selected", callerSalt)).resolves.toBe(expected);
  expect(password).toEqual(new Uint8Array(8));
  expect(ownSalt).toEqual(new Uint8Array(16));
  expect(derived).toEqual(new Uint8Array(32));
  expect(callerSalt).toEqual(before);
});

it("releases busy and wipes input after actual work rejection", async () => {
  let owned: Uint8Array | undefined;
  work.mockImplementationOnce(async (encoded) => {
    owned = encoded;
    throw new Error("Controlled KDF failure.");
  });
  await expect(derive("reject", salt())).rejects.toThrow(
    /Controlled KDF failure/,
  );
  expect(owned).toEqual(new Uint8Array(6));
  work.mockResolvedValueOnce(output());
  await expect(derive("recovered", salt())).resolves.toBeTypeOf("string");
});

it("wipes malformed derived output and recovers; verification preserves caller expected bytes", async () => {
  const malformed = new Uint8Array(31).fill(9);
  work.mockResolvedValueOnce(malformed);
  await expect(derive("bad output", salt())).rejects.toThrow(
    /Invalid retired credential derivation/,
  );
  expect(malformed).toEqual(new Uint8Array(31));
  const expected = output();
  const original = expected.slice();
  const derived = output();
  work.mockResolvedValueOnce(derived);
  await expect(verify("valid", salt(), expected)).resolves.toBe(true);
  expect(expected).toEqual(original);
  expect(derived).toEqual(new Uint8Array(32));
});

it("preserves Node Buffer salt and expected through success, failure and overlap", async () => {
  const callerSalt = Buffer.from(salt());
  const expected = Buffer.from(output());
  const saltBefore = Buffer.from(callerSalt);
  const expectedBefore = Buffer.from(expected);
  const preserved = () => {
    expect(callerSalt).toEqual(saltBefore);
    expect(expected).toEqual(expectedBefore);
  };
  work.mockResolvedValueOnce(output());
  await expect(verify("selected", callerSalt, expected)).resolves.toBe(true);
  preserved();
  work.mockRejectedValueOnce(new Error("Controlled Buffer work failure."));
  await expect(verify("selected", callerSalt, expected)).rejects.toThrow(
    /Controlled Buffer work failure/,
  );
  preserved();
  let finish: ((bytes: Uint8Array) => void) | undefined;
  work.mockImplementationOnce(
    () =>
      new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = derive("held", callerSalt);
  if (!finish) throw new Error("Controlled Buffer work did not start.");
  const release = finish;
  try {
    await expect(verify("overlap", callerSalt, expected)).rejects.toThrow(
      /already running/,
    );
    preserved();
    expect(work).toHaveBeenCalledTimes(3);
  } finally {
    release(output());
    await pending;
  }
  preserved();
});
