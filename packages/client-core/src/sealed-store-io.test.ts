import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  b64ToBytes,
  bytesToB64,
  loadSealedStore,
  parseSealedStore,
  persistSealedStore,
  sealDevOnly,
} from "./index.js";

/**
 * A minimal OPFS stand-in: a directory of named files held in memory, shaped
 * exactly like the slice of the File System Access API the façade uses.
 */
function stubOpfs(files = new Map<string, string>()) {
  const requestedNames: string[] = [];
  const root = {
    getFileHandle(name: string, opts?: { create?: boolean }) {
      requestedNames.push(name);
      if (!files.has(name)) {
        if (!opts?.create) return Promise.reject(new Error("not found"));
        files.set(name, "");
      }
      return Promise.resolve({
        createWritable() {
          return Promise.resolve({
            write(data: string) {
              files.set(name, data);
              return Promise.resolve();
            },
            close() {
              return Promise.resolve();
            },
          });
        },
        getFile() {
          return Promise.resolve({
            text: () => Promise.resolve(files.get(name) ?? ""),
          });
        },
      });
    },
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: () => Promise.resolve(root) },
  });
  return { files, requestedNames };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes, including those above latin1 ASCII", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
  });

  it("encodes to standard base64", () => {
    expect(bytesToB64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(bytesToB64(new Uint8Array())).toBe("");
  });

  it("refuses input that is not base64", () => {
    expect(() => b64ToBytes("not base64!!")).toThrow(/not base64/);
  });
});

describe("parseSealedStore guards", () => {
  const store = (overrides: JsonObject) =>
    JSON.stringify({
      cursor: { device_id: "d", epoch: 0 },
      blobs: [],
      ...overrides,
    });

  it("rejects a cursor that does not carry exactly a device id and epoch", () => {
    // Unknown keys are where a plaintext document would hide.
    expect(
      parseSealedStore(
        store({ cursor: { device_id: "d", epoch: 0, password: "hunter2" } }),
      ),
    ).toBeNull();
    // A device id that is not a string cannot be a safe file name either.
    expect(
      parseSealedStore(store({ cursor: { device_id: 42, epoch: 0 } })),
    ).toBeNull();
    expect(
      parseSealedStore(store({ cursor: { device_id: "d", epoch: "0" } })),
    ).toBeNull();
    // An epoch that cannot be represented exactly is not an epoch.
    expect(
      parseSealedStore(
        store({ cursor: { device_id: "d", epoch: Number.MAX_SAFE_INTEGER } }),
      ),
    ).not.toBeNull();
  });

  it("rejects blob sections that are not bounded arrays of sealed blobs", () => {
    expect(parseSealedStore(store({ blobs: {} }))).toBeNull();
    // One over the bound is already too many to be trusted whole.
    const tooMany = Array.from({ length: 4097 }, (_, i) => ({
      id: `b${i}`,
      epoch: 0,
      ciphertextB64: "",
    }));
    expect(parseSealedStore(store({ blobs: tooMany }))).toBeNull();
    // Exactly at the bound is still a store.
    expect(
      parseSealedStore(store({ blobs: tooMany.slice(0, 4096) })),
    ).not.toBeNull();
  });

  it("rejects blob entries that are not exactly id, epoch and ciphertext", () => {
    for (const entry of [null, 42, "x"]) {
      expect(parseSealedStore(store({ blobs: [entry] }))).toBeNull();
    }
    // Bad id or epoch, with no stray key to blame it on.
    expect(
      parseSealedStore(
        store({ blobs: [{ id: "../escape", epoch: 0, ciphertextB64: "" }] }),
      ),
    ).toBeNull();
    expect(
      parseSealedStore(
        store({ blobs: [{ id: "b", epoch: -1, ciphertextB64: "" }] }),
      ),
    ).toBeNull();
    // Ciphertext that is not base64, or not even a string, is not ciphertext.
    expect(
      parseSealedStore(
        store({ blobs: [{ id: "b", epoch: 0, ciphertextB64: 5 }] }),
      ),
    ).toBeNull();
    expect(
      parseSealedStore(
        store({ blobs: [{ id: "b", epoch: 0, ciphertextB64: "not b64!!" }] }),
      ),
    ).toBeNull();
  });

  it("accepts a store with empty blobs and empty ciphertext", () => {
    const doc = store({ blobs: [{ id: "b", epoch: 0, ciphertextB64: "" }] });
    expect(parseSealedStore(doc)).toEqual({
      cursor: { device_id: "d", epoch: 0 },
      blobs: [{ id: "b", epoch: 0, ciphertextB64: "" }],
    });
  });
});

describe("sealed store IO against OPFS", () => {
  const mine = JSON.stringify({
    cursor: { device_id: "opfs-device", epoch: 3 },
    blobs: [{ id: "b1", epoch: 3, ciphertextB64: "AAECAw==" }],
  });

  it("persists to and loads from OPFS when it is available", async () => {
    const { files, requestedNames } = stubOpfs();
    await persistSealedStore("opfs-device", mine);
    // One file per device, named after the device and nothing else.
    expect(files.get("opensesame-sync-opfs-device.json")).toBe(mine);
    expect(await loadSealedStore("opfs-device")).toBe(mine);
    expect(requestedNames).toEqual([
      "opensesame-sync-opfs-device.json",
      "opensesame-sync-opfs-device.json",
    ]);
  });

  it("sanitizes characters in a device name before it becomes a file name", async () => {
    const { requestedNames } = stubOpfs();
    expect(await loadSealedStore("../strange device")).toBeNull();
    expect(requestedNames).toEqual(["opensesame-sync-.._strange_device.json"]);
  });

  it("treats a half-written or planted OPFS file as absent", async () => {
    const { files } = stubOpfs(
      new Map([["opensesame-sync-opfs-device.json", '{"cursor":{"device_id"']]),
    );
    expect(await loadSealedStore("opfs-device")).toBeNull();
    files.set("opensesame-sync-opfs-device.json", "not json at all");
    expect(await loadSealedStore("opfs-device")).toBeNull();
  });

  it("will not hand back an OPFS store that names another device", async () => {
    const theirs = JSON.stringify({
      cursor: { device_id: "other-device", epoch: 1 },
      blobs: [],
    });
    stubOpfs(new Map([["opensesame-sync-opfs-device.json", theirs]]));
    expect(await loadSealedStore("opfs-device")).toBeNull();
  });

  it("falls back to memory when OPFS rejects the write", async () => {
    const root = {
      getFileHandle: () => Promise.reject(new Error("opfs disabled")),
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(root) },
    });
    await expect(persistSealedStore("mem-device", mine)).rejects.toThrow(
      /another device/,
    );
    const memDoc = JSON.stringify({
      cursor: { device_id: "mem-device", epoch: 1 },
      blobs: [],
    });
    await persistSealedStore("mem-device", memDoc);
    // The load path also finds OPFS broken and reads the memory fallback.
    expect(await loadSealedStore("mem-device")).toBe(memDoc);
  });
});

describe("sealDevOnly environment gate", () => {
  it("honors the explicit dev-seal opt-in even without a dev NODE_ENV", () => {
    const g = overlapCast(globalThis);
    const prevEnv = process.env.NODE_ENV;
    g.__OPENSESAME_ALLOW_DEV_SEAL__ = true;
    process.env.NODE_ENV = "production";
    try {
      expect(sealDevOnly(new Uint8Array([1]), new Uint8Array([2]))).toEqual(
        new Uint8Array([3]),
      );
    } finally {
      Reflect.deleteProperty(g, "__OPENSESAME_ALLOW_DEV_SEAL__");
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("repeats a short key over longer plaintext", () => {
    expect(
      sealDevOnly(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1])),
    ).toEqual(new Uint8Array([0, 3, 2, 5]));
  });
});
