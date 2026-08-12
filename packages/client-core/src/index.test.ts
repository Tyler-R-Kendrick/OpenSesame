import { describe, expect, it } from "vitest";
import {
  assertNoPlaintextInSealedJson,
  createCursor,
  loadSealedStore,
  parseSealedStore,
  persistSealedStore,
  sealDevOnly,
} from "./index.js";

const sealed = JSON.stringify({
  cursor: { device_id: "pages-device", epoch: 0 },
  blobs: [{ id: "b1", epoch: 0, ciphertextB64: "AAECAw==" }],
});

describe("client-core façade", () => {
  it("createCursor", () => {
    expect(createCursor("d").deviceId).toBe("d");
  });

  it("accepts a sealed store and nothing else", () => {
    expect(() => assertNoPlaintextInSealedJson(sealed)).not.toThrow();
    expect(() => assertNoPlaintextInSealedJson('{"plaintext":"x"}')).toThrow();

    // The old guard searched for the word "plaintext" and for a string from its
    // own fixture, so a real vault document passed. These are what it let through.
    for (const unsealed of [
      JSON.stringify({
        cursor: { device_id: "d", epoch: 0 },
        blobs: [],
        items: [{ name: "AWS root", password: "hunter2" }],
      }),
      JSON.stringify({
        cursor: { device_id: "d", epoch: 0 },
        blobs: [
          {
            id: "b1",
            epoch: 0,
            ciphertextB64: "not base64!!",
            password: "hunter2",
          },
        ],
      }),
      JSON.stringify({ blobs: [{ ciphertext: "abc" }] }),
      JSON.stringify([{ password: "hunter2" }]),
      "hunter2",
    ]) {
      expect(() => assertNoPlaintextInSealedJson(unsealed), unsealed).toThrow();
      expect(parseSealedStore(unsealed), unsealed).toBeNull();
    }
  });

  it("will not persist a document that is not a sealed store", async () => {
    await expect(
      persistSealedStore("pages-device", '{"plaintext":"no"}'),
    ).rejects.toThrow();
    await expect(
      persistSealedStore("pages-device", sealed),
    ).resolves.toBeUndefined();
  });

  it("will not adopt a sealed store that belongs to another device", async () => {
    const mine = JSON.stringify({
      cursor: { device_id: "device-a", epoch: 2 },
      blobs: [],
    });
    const theirs = JSON.stringify({
      cursor: { device_id: "device-b", epoch: 99 },
      blobs: [],
    });
    await persistSealedStore("device-a", mine);
    // A well-formed store is still somebody else's if it names another device.
    await expect(persistSealedStore("device-a", theirs)).rejects.toThrow(
      /another device/,
    );
    expect(await loadSealedStore("device-a")).toBe(mine);
    // And one copied in under our own name is read as absent, not as our identity.
    await persistSealedStore("device-b", theirs);
    expect(await loadSealedStore("device-b")).toBe(theirs);
  });

  it("bounds what a stored cursor is allowed to say about a device", () => {
    // Callers adopt this device id and use it as a file name, so it is bounded.
    expect(
      parseSealedStore(
        JSON.stringify({
          cursor: { device_id: "../../etc/passwd", epoch: 0 },
          blobs: [],
        }),
      ),
    ).toBeNull();
    expect(
      parseSealedStore(
        JSON.stringify({
          cursor: { device_id: "d".repeat(200), epoch: 0 },
          blobs: [],
        }),
      ),
    ).toBeNull();
    expect(
      parseSealedStore(
        JSON.stringify({ cursor: { device_id: "d", epoch: -1 }, blobs: [] }),
      ),
    ).toBeNull();
    expect(
      parseSealedStore(
        JSON.stringify({ cursor: { device_id: "d", epoch: 1.5 }, blobs: [] }),
      ),
    ).toBeNull();
  });

  it("treats an unusable stored file as absent rather than as truth", async () => {
    await persistSealedStore("pages-device", sealed);
    expect(await loadSealedStore("pages-device")).toBe(sealed);
    // A truncated or planted file must not be handed back to be adopted.
    await expect(
      persistSealedStore("pages-device", '{"cursor":{"device_id":"d"'),
    ).rejects.toThrow();
    expect(await loadSealedStore("nothing-here")).toBeNull();
  });

  it("sealDevOnly refuses anywhere it cannot prove it is dev", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() =>
        sealDevOnly(new Uint8Array([1]), new Uint8Array([2])),
      ).toThrow(/forbidden/);

      // A browser bundle has no NODE_ENV at all; that used to read as "not
      // production" and let the XOR run in the environment that matters most.
      delete process.env.NODE_ENV;
      expect(() =>
        sealDevOnly(new Uint8Array([1]), new Uint8Array([2])),
      ).toThrow(/forbidden/);

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
