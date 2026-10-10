/**
 * A wrapped share opens for one circle, guardian, key and epoch, under one PRF
 * output, and for nothing else.
 */
import { describe, expect, it } from "vitest";
import { randomBytes, toB64url } from "./bytes.js";
import { WrapError, prfInput, unwrapShare, wrapShare } from "./wrap.js";

describe("a wrapped share opens for one context only", () => {
  const ctx = {
    circleId: "c-1",
    guardianId: "g-1",
    credentialId: "k-1",
    epoch: 1,
  };
  const mnemonic = "academic acid acne acquire acrobat activity";
  const output = randomBytes(32);

  it("round-trips and normalizes the words", () => {
    const sealed = wrapShare(`  ${mnemonic.toUpperCase()} `, ctx, output);
    expect(unwrapShare(sealed, ctx, output)).toBe(mnemonic);
  });

  it("refuses another circle, guardian, key, epoch or PRF output", () => {
    const sealed = wrapShare(mnemonic, ctx, output);
    for (const wrong of [
      { ...ctx, circleId: "c-2" },
      { ...ctx, guardianId: "g-2" },
      { ...ctx, epoch: 2 },
    ]) {
      expect(() => unwrapShare(sealed, wrong, output)).toThrow(WrapError);
    }
    expect(() =>
      unwrapShare(sealed, { ...ctx, credentialId: "k-2" }, output),
    ).toThrow(WrapError);
    expect(() => unwrapShare(sealed, ctx, randomBytes(32))).toThrow(WrapError);
  });

  it("refuses a PRF output that is too short to be a key", () => {
    expect(() => wrapShare(mnemonic, ctx, randomBytes(16))).toThrow(WrapError);
  });

  it("uses a fresh nonce each time and a per-circle PRF input", () => {
    const a = wrapShare(mnemonic, ctx, output);
    const b = wrapShare(mnemonic, ctx, output);
    expect(a.nonce).not.toBe(b.nonce);
    expect(toB64url(prfInput("c-1", "g-1"))).not.toBe(
      toB64url(prfInput("c-2", "g-1")),
    );
    expect(toB64url(prfInput("c-1", "g-1"))).not.toBe(
      toB64url(prfInput("c-1", "g-2")),
    );
  });
});
