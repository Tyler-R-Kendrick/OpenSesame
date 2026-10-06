import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import envelopeVectors from "../../../../spec/conformance/sealed-log-envelope-vectors.json" with {
  type: "json",
};
import vectors from "../../../../spec/conformance/sealed-log-vectors.json" with {
  type: "json",
};
import {
  SealedLogFile,
  UNREADABLE,
  createSealedLogDestination,
  loadLogKey,
  openLogLine,
  readSealedTail,
  sealExistingLog,
  sealLogLine,
} from "../sealed-log.js";

it("binds envelopes to the trusted key namespace even when customer root bytes match", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-envelope-"));
  const a = join(dir, "customer-a.key");
  const b = join(dir, "customer-b.key");
  writeFileSync(a, vectors.key);
  writeFileSync(b, vectors.key);
  const first = loadLogKey(a);
  const second = loadLogKey(b);
  const sealed = sealLogLine(first, "customer A private line");
  expect(openLogLine(loadLogKey(a), sealed)).toBe("customer A private line");
  expect(openLogLine(second, sealed)).toBeNull();
  const encoded = Buffer.from(sealed.slice(5), "base64url");
  const again = Buffer.from(
    sealLogLine(first, "customer A private line").slice(5),
    "base64url",
  );
  expect(encoded.subarray(24, 72)).not.toEqual(again.subarray(24, 72));
  expect(openLogLine(first, `${sealed}=`)).toBeNull();
  const log = join(dir, "customer-b.log");
  writeFileSync(log, `${sealed}\n`);
  expect(readSealedTail(log, second, 1)).toEqual([UNREADABLE]);
  expect(() => sealExistingLog(log, second)).toThrow();
  expect(readFileSync(log, "utf8")).toBe(`${sealed}\n`);
});
it("upgrades legacy direct-key lines without changing their plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-envelope-"));
  const log = join(dir, "service.log");
  const path = `${log}.key`;
  writeFileSync(path, vectors.key);
  const legacy = vectors.lines[0];
  if (!legacy) throw new Error("missing conformance fixture");
  writeFileSync(log, `${legacy.sealed}\n`);
  const key = loadLogKey(path);
  expect(sealExistingLog(log, key)).toBe(1);
  expect(readFileSync(log, "utf8")).toMatch(/^osl2\./u);
  expect(readSealedTail(log, key, 1)).toEqual([legacy.plain]);
  expect(sealExistingLog(log, key)).toBe(0);
});
it("refuses missing roots and unsupported sealed versions across rotated generations", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-envelope-"));
  const log = join(dir, "service.log");
  writeFileSync(`${log}.64`, "osl9.not-a-supported-envelope\n");
  expect(() => createSealedLogDestination(log)).toThrow(/key is missing/u);
  expect(existsSync(`${log}.key`)).toBe(false);
  writeFileSync(`${log}.key`, vectors.key);
  expect(() => createSealedLogDestination(log)).toThrow(/cannot be opened/u);
  expect(readSealedTail(`${log}.64`, loadLogKey(`${log}.key`), 1)).toEqual([
    UNREADABLE,
  ]);
});

it.each(envelopeVectors.lines)(
  "opens the shared envelope vector: $plain",
  (vector) => {
    const key = Uint8Array.from(Buffer.from(envelopeVectors.key, "hex"));
    expect(openLogLine(key, vector.sealed)).toBe(vector.plain);
  },
);

it("refuses oversized sealed input before decoding", () => {
  const key = new Uint8Array(32).fill(7);
  expect(openLogLine(key, `osl2.${"A".repeat(32 * 1024 * 1024)}`)).toBeNull();
});

it("refuses direct append construction under a replacement root", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-envelope-"));
  const log = join(dir, "service.log");
  const first = new Uint8Array(32).fill(7);
  const original = `${sealLogLine(first, "retained customer event")}\n`;
  writeFileSync(log, original);
  expect(() => new SealedLogFile(log, new Uint8Array(32).fill(8))).toThrow(
    /cannot be opened/u,
  );
  expect(readFileSync(log, "utf8")).toBe(original);
});

it.each(["", ".64"])(
  "does not mint a root for whitespace-prefixed ciphertext in generation %s",
  (suffix) => {
    const dir = mkdtempSync(join(tmpdir(), "log-envelope-"));
    const log = join(dir, "service.log");
    const legacy = vectors.lines[0];
    if (!legacy) throw new Error("missing conformance fixture");
    const original = `  \t${legacy.sealed}  \n`;
    writeFileSync(`${log}${suffix}`, original);
    expect(() => createSealedLogDestination(log)).toThrow(/key is missing/u);
    expect(existsSync(`${log}.key`)).toBe(false);
    expect(readFileSync(`${log}${suffix}`, "utf8")).toBe(original);
  },
);
it("classifies whitespace-prefixed legacy and current envelopes without double encryption", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-envelope-"));
  const log = join(dir, "service.log");
  writeFileSync(`${log}.key`, vectors.key);
  const key = loadLogKey(`${log}.key`);
  const legacy = vectors.lines[0];
  if (!legacy) throw new Error("missing conformance fixture");
  const current = sealLogLine(key, "current customer line");
  writeFileSync(log, `  ${legacy.sealed}  \n  ${current}  \n`);
  expect(readSealedTail(log, key, 2)).toEqual([
    legacy.plain,
    "current customer line",
  ]);
  expect(sealExistingLog(log, key)).toBe(1);
  expect(readSealedTail(log, key, 2)).toEqual([
    legacy.plain,
    "current customer line",
  ]);
  expect(sealExistingLog(log, key)).toBe(0);
});
