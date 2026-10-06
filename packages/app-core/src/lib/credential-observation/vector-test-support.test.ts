import { describe, expect, it } from "vitest";
import vectors from "./protocol-vectors.json";
import {
  publicVectorProvision,
  publicVectorSchema,
} from "./vector-test-support.js";

describe("public numeric interoperability fixture", () => {
  it("reconstructs exactly public bytes zero through sixty-three", () => {
    const provision = publicVectorProvision();
    expect([
      ...Buffer.from(provision.independentKeyMaterialB64, "base64"),
    ]).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(vectors.provision).not.toHaveProperty("independentKeyMaterialB64");
  });
  it("refuses malformed byte counts and noninteger or nonbyte values", () => {
    for (const bytes of [
      [],
      Array(63).fill(0),
      Array(65).fill(0),
      [true, ...Array(63).fill(0)],
      [-1, ...Array(63).fill(0)],
      [256, ...Array(63).fill(0)],
      [0.5, ...Array(63).fill(0)],
      ["0", ...Array(63).fill(0)],
    ]) {
      expect(() =>
        publicVectorProvision(
          publicVectorSchema.parse({
            ...vectors,
            publicIndependentKeyBytes: bytes,
          }),
        ),
      ).toThrow();
    }
  });
  it("keeps production wire parsing closed and rejects an encoded-key fixture shortcut", () => {
    expect(() =>
      publicVectorProvision({
        ...vectors,
        provision: {
          ...vectors.provision,
          independentKeyMaterialB64: "public fixture shortcut",
        },
      }),
    ).toThrow();
    expect(() =>
      publicVectorProvision({
        ...vectors,
        provision: {
          ...vectors.provision,
          password: "must not enter closed pairing wire",
        },
      }),
    ).toThrow();
  });
});
