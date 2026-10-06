/**
 * RFC 9497 Appendix A.1.1 (ristretto255-SHA512, OPRF mode 0x00) against the
 * `@noble/curves` suite the Sphinx generator stands on.
 */
import { ristretto255_oprf } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

const oprf = ristretto255_oprf.oprf;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

const SEED = "a3".repeat(32);
const KEY_INFO = new TextEncoder().encode("test key");
const SK = "5ebcea5ee37023ccb9fc2d2019f9d7737be85591ae8652ffa9ef0f4d37063b0e";
const BLIND =
  "64d37aed22a27f5191de1c1d69fadb899d8862b58eb4220029e036ec4c1f6706";

const VECTORS = [
  {
    input: "00",
    blinded: "609a0ae68c15a3cf6903766461307e5c8bb2f95e7e6550e1ffa2dc99e412803c",
    evaluated:
      "7ec6578ae5120958eb2db1745758ff379e77cb64fe77b0b2d8cc917ea0869c7e",
    output:
      "527759c3d9366f277d8c6020418d96bb393ba2afb20ff90df23fb7708264e2f3ab9135e3bd69955851de4b1f9fe8a0973396719b7912ba9ee8aa7d0b5e24bcf6",
  },
  {
    input: "5a".repeat(17),
    blinded: "da27ef466870f5f15296299850aa088629945a17d1f5b7f5ff043f76b3c06418",
    evaluated:
      "b4cbf5a4f1eeda5a63ce7b77c7d23f461db3fcab0dd28e4e17cecb5c90d02c25",
    output:
      "f4a74c9c592497375e796aa837e907b1a045d34306a749db9f34221f7e750cb4f2a6413a6bf6fa5e19ba6348eb673934a722a7ede2e7621306d18951e7cf2c73",
  },
] as const;

/** An RNG that makes `blind()` use the RFC's scalar: noble maps bytes to `1 + (n mod (order - 1))`. */
function fixedBlind(scalarHex: string): (length?: number) => Uint8Array {
  const scalar = BigInt(`0x${hex(bytes(scalarHex).reverse())}`) - 1n;
  return (length = 48) => {
    const out = new Uint8Array(length);
    let rest = scalar;
    for (let i = 0; i < length; i += 1) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return out;
  };
}

describe("RFC 9497 ristretto255-SHA512 OPRF", () => {
  const keys = oprf.deriveKeyPair(bytes(SEED), KEY_INFO);

  it("derives the RFC key pair", () => {
    expect(hex(keys.secretKey)).toBe(SK);
  });

  for (const [index, vector] of VECTORS.entries()) {
    it(`matches test vector ${index + 1} end to end`, () => {
      const input = bytes(vector.input);
      const blind = oprf.blind(input, fixedBlind(BLIND));
      expect(hex(blind.blind)).toBe(BLIND);
      expect(hex(blind.blinded)).toBe(vector.blinded);
      const evaluated = oprf.blindEvaluate(keys.secretKey, blind.blinded);
      expect(hex(evaluated)).toBe(vector.evaluated);
      expect(hex(oprf.finalize(input, blind.blind, evaluated))).toBe(
        vector.output,
      );
    });
  }

  it("gives the same output whatever blind is used", () => {
    const input = bytes("0102030405");
    const outputs = [0, 1].map(() => {
      const blind = oprf.blind(input);
      const evaluated = oprf.blindEvaluate(keys.secretKey, blind.blinded);
      return hex(oprf.finalize(input, blind.blind, evaluated));
    });
    expect(outputs[0]).toBe(outputs[1]);
  });
});
