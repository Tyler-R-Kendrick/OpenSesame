/** Actual KV memory and fixed Argon2 vectors; these tests grant no authority. */
import { afterEach, expect, it, vi } from "vitest";
import { kvDelete, kvSet } from "../kv.js";
import * as argon from "./argon-verifier.js";
import { key, matches, read, verifier } from "./record-access.js";
import type { TrapRecord } from "./records.js";
const tomb = "inactive-record-access-fixture";
const salt = "AAECAwQFBgcICQoLDA0ODw==";
const ascii = "lF4CYhE/M319Ne3ZL58n9f15oXGjfYdF8TdmQkbeLmg=";
const composed = "Svrnm0NbynXcv+AOADvcLD9ZtS9zfAgKsATQuOLhu/4=";
const decomposed = "G6qJ1Y+XvLqVQz7XyZoyopoQBpvz5hEP8Ns9BLsjerc=";
const trap = (id: string, digest = ascii): TrapRecord => ({
  id,
  createdAt: "2026-10-08T00:00:00.000Z",
  response: "reject",
  salt,
  verifier: digest,
});
afterEach(() => {
  kvDelete(key(tomb));
  vi.restoreAllMocks();
});

it("distinguishes absent from present-empty, invalid and wrong-context actual KV", () => {
  kvDelete(key(tomb));
  expect(read(tomb)).toEqual({ v: 1, tomb, traps: [], events: [] });
  for (const value of [
    "",
    "null",
    "{}",
    JSON.stringify({ v: 1, tomb: "other", traps: [], events: [] }),
  ]) {
    kvSet(key(tomb), value);
    expect(() => read(tomb)).toThrow(/unavailable/);
  }
  kvSet(
    key(tomb),
    JSON.stringify({ v: 1, tomb, traps: [trap("selected")], events: [] }),
  );
  expect(read(tomb).traps).toEqual([trap("selected")]);
});
it("refuses oversized actual KV memory and invalid exact contexts", () => {
  kvSet(key(tomb), " ".repeat(32769));
  expect(() => read(tomb)).toThrow(/unavailable/);
  for (const context of [
    "",
    "a".repeat(257),
    "../personal",
    "personal/other",
    "\ud800",
  ])
    expect(() => key(context)).toThrow();
  expect(key("personal")).toBe("tomb/personal/retired-credentials.v1");
});
it("uses the new string-returning physical verifier API", async () => {
  await expect(verifier("Retired vector password", salt)).resolves.toBe(ascii);
});
it("checks all three physical KDFs despite an early match", async () => {
  const calls = vi.spyOn(argon, "verifyRetiredPassword"); // call-through, no verdict mock
  await expect(
    matches("Retired vector password", [
      trap("first"),
      trap("second", composed),
      trap("third", decomposed),
    ]),
  ).resolves.toEqual(trap("first"));
  expect(calls).toHaveBeenCalledTimes(3);
});
it("checks the final physical KDF before refusing duplicate matches", async () => {
  const calls = vi.spyOn(argon, "verifyRetiredPassword");
  await expect(
    matches("Retired vector password", [
      trap("first"),
      trap("duplicate"),
      trap("last", composed),
    ]),
  ).rejects.toThrow(/Ambiguous/);
  expect(calls).toHaveBeenCalledTimes(3);
});
it("matches exact unnormalized Unicode with real fixed vectors", async () => {
  await expect(
    matches("e\u0301", [
      trap("composed", composed),
      trap("decomposed", decomposed),
    ]),
  ).resolves.toEqual(trap("decomposed", decomposed));
});
it("bounds probes before work even with no traps", async () => {
  const calls = vi.spyOn(argon, "verifyRetiredPassword");
  for (const probe of [
    "",
    "a".repeat(4097),
    "é".repeat(2049),
    "\ud800",
    "\udc00",
  ])
    await expect(matches(probe, [])).rejects.toThrow();
  await expect(matches("a".repeat(4096), [])).resolves.toBeNull();
  expect(calls).not.toHaveBeenCalled();
});
it("refuses count, decoded length and noncanonical encodings before any KDF", async () => {
  const calls = vi.spyOn(argon, "verifyRetiredPassword");
  const invalid = [
    [trap("a"), trap("b"), trap("c"), trap("d")],
    [{ ...trap("a"), salt: salt.slice(0, -2) }],
    [{ ...trap("a"), salt: `${salt.slice(0, 21)}x==` }],
    [{ ...trap("a"), verifier: `${ascii.slice(0, 42)}h=` }],
    [{ ...trap("a"), verifier: btoa("a".repeat(31)) }],
  ];
  for (const traps of invalid)
    await expect(matches("valid", traps)).rejects.toThrow();
  expect(calls).not.toHaveBeenCalled();
});
