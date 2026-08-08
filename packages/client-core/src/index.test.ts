import { describe, expect, it } from "vitest";
import {
  assertNoPlaintextInSealedJson,
  createCursor,
  persistSealedStore,
  sealDevOnly,
} from "./index.js";

describe("client-core façade", () => {
  it("createCursor", () => {
    expect(createCursor("d").deviceId).toBe("d");
  });

  it("assertNoPlaintextInSealedJson", () => {
    expect(() =>
      assertNoPlaintextInSealedJson('{"blobs":[{"ciphertext":"abc"}]}'),
    ).not.toThrow();
    expect(() => assertNoPlaintextInSealedJson('{"plaintext":"x"}')).toThrow();
  });

  it("persistSealedStore rejects plaintext marker", async () => {
    await expect(
      persistSealedStore("t", '{"plaintext":"no"}'),
    ).rejects.toThrow();
  });

  it("sealDevOnly refuses anywhere it cannot prove it is dev", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => sealDevOnly(new Uint8Array([1]), new Uint8Array([2]))).toThrow(
        /forbidden/,
      );

      // A browser bundle has no NODE_ENV at all; that used to read as "not
      // production" and let the XOR run in the environment that matters most.
      delete process.env.NODE_ENV;
      expect(() => sealDevOnly(new Uint8Array([1]), new Uint8Array([2]))).toThrow(
        /forbidden/,
      );

      process.env.NODE_ENV = "test";
      expect(sealDevOnly(new Uint8Array([1]), new Uint8Array([2]))).toEqual(
        new Uint8Array([3]),
      );
      expect(() => sealDevOnly(new Uint8Array([1]), new Uint8Array())).toThrow(
        /requires a key/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
