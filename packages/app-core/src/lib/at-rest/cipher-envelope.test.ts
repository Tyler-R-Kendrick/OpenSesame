import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  atRestBinding,
  isSealedAtRest,
  openAtRest,
  sealAtRest,
} from "./cipher.js";
const root = new Uint8Array(32).fill(19);
const binding = atRestBinding("customer-a", "vault/secret");
describe("record envelope segmentation", () => {
  it("rejects weak root keys", () => {
    expect(() => sealAtRest(new Uint8Array(1), binding, "secret")).toThrow();
    expect(
      openAtRest(
        new Uint8Array(1),
        binding,
        sealAtRest(root, binding, "secret"),
      ),
    ).toBeNull();
  });
  it("uses fresh envelopes and rejects different customers, records and roots", () => {
    const first = sealAtRest(root, binding, "private credential");
    expect(first).toMatch(/^osr2\./);
    expect(first).not.toEqual(sealAtRest(root, binding, "private credential"));
    expect(openAtRest(root, binding, first)).toBe("private credential");
    expect(
      openAtRest(root, atRestBinding("customer-b", "vault/secret"), first),
    ).toBeNull();
    expect(
      openAtRest(root, atRestBinding("customer-a", "other"), first),
    ).toBeNull();
    expect(openAtRest(new Uint8Array(32).fill(20), binding, first)).toBeNull();
  });
  it("authenticates wrapped keys, nonces and data and rejects unknown versions", () => {
    const sealed = sealAtRest(root, binding, "private credential");
    for (const position of [0, 24, 71, 72, 95, 96]) {
      const bytes = b64urlToBytes(sealed.slice(5));
      bytes[position] ^= 1;
      expect(
        openAtRest(root, binding, `osr2.${bytesToB64url(bytes)}`),
      ).toBeNull();
    }
    expect(
      openAtRest(root, binding, sealed.replace("osr2", "osr1")),
    ).toBeNull();
    expect(openAtRest(root, binding, "osr2.AA")).toBeNull();
    expect(isSealedAtRest("osr9.AA")).toBe(true);
    expect(openAtRest(root, binding, "osr9.AA")).toBeNull();
  });
  it("reads actual legacy ciphertext under historical associated data", () => {
    const nonce = new Uint8Array(24).fill(7);
    const aad = new TextEncoder().encode(
      "opensesame.at-rest.v1\u0000customer-a\u0000vault/secret",
    );
    const body = xchacha20poly1305(root, nonce, aad).encrypt(
      new TextEncoder().encode("legacy secret"),
    );
    const bytes = new Uint8Array(nonce.length + body.length);
    bytes.set(nonce);
    bytes.set(body, nonce.length);
    expect(openAtRest(root, binding, `osr1.${bytesToB64url(bytes)}`)).toBe(
      "legacy secret",
    );
    expect(
      openAtRest(
        root,
        atRestBinding("customer-b", "vault/secret"),
        `osr1.${bytesToB64url(bytes)}`,
      ),
    ).toBeNull();
  });
  it("cannot alias delimiter-containing customer or record names", () => {
    const left = atRestBinding("a\u0000b", "c");
    const right = atRestBinding("a", "b\u0000c");
    expect(left).not.toEqual(right);
    const sealed = sealAtRest(root, left, "private credential");
    expect(openAtRest(root, left, sealed)).toBe("private credential");
    expect(openAtRest(root, right, sealed)).toBeNull();
  });
});
