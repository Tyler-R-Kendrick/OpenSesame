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

  it("sealDevOnly forbidden in production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => sealDevOnly(new Uint8Array([1]), new Uint8Array([2]))).toThrow(
        /forbidden/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
