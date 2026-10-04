import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newVapid, vapidFromScalar } from "./push-stack.mjs";

const publicOf = (privateKey) => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  return ecdh.getPublicKey().toString("base64url");
};

describe("the push stack's application server key", () => {
  it("is a 32-octet scalar that matches its public point, every time", () => {
    for (let i = 0; i < 3000; i += 1) {
      const { publicKey, privateKey } = newVapid();
      expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
      expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);
      expect(publicOf(privateKey)).toBe(publicKey);
    }
  });

  it("pads a scalar with leading zero octets on the left, so it still matches", () => {
    for (const zeros of [1, 2, 3]) {
      const short = Buffer.concat([
        Buffer.alloc(0),
        crypto.randomBytes(32 - zeros),
      ]);
      expect(short.length).toBe(32 - zeros);
      const { publicKey, privateKey } = vapidFromScalar(short);
      const bytes = Buffer.from(privateKey, "base64url");
      expect(bytes).toHaveLength(32);
      expect([...bytes.subarray(0, zeros)]).toEqual(Array(zeros).fill(0));
      expect(publicOf(privateKey)).toBe(publicKey);
    }
  });

  it("is the case right-padding got wrong: a real short scalar from Node", () => {
    let found = null;
    for (let i = 0; i < 20000 && found === null; i += 1) {
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      if (ecdh.getPrivateKey().length < 32) found = ecdh;
    }
    expect(found).not.toBeNull();
    const scalar = found.getPrivateKey();
    const rightPadded = scalar.toString("base64url").padEnd(43, "A");
    // The old form named another scalar entirely, so it could not match.
    expect(publicOf(rightPadded)).not.toBe(
      found.getPublicKey().toString("base64url"),
    );
    const { publicKey, privateKey } = vapidFromScalar(scalar);
    expect(publicKey).toBe(found.getPublicKey().toString("base64url"));
    expect(publicOf(privateKey)).toBe(publicKey);
  });
});

describe("the subscription limit the walks use", () => {
  const read = (name) =>
    readFileSync(path.join(import.meta.dirname, name), "utf8");

  it("is the server's own constant, never a copy of its number", () => {
    expect(read("push-stack.mjs")).toMatch(
      /MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL[\s\S]*limit: MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL/,
    );
    for (const name of ["../verify-push.mjs", "capture-push-steps.mjs"]) {
      const source = read(name);
      expect(source, name).not.toMatch(/\bLIMIT\s*=\s*\d+/);
      expect(source, name).toMatch(/stack\.limit/);
    }
  });
});
