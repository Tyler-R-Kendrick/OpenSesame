/** Real bound AES-GCM both directions and accepted original method lifetime; no storage or Root admission claim. */
import {
  mintVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { captureOriginalDeviceIdentitySealData } from "./original-device-identity-seal-data.js";
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => vi.restoreAllMocks());
const binding = vaultSealBinding("personal", "config/device-identity-key");
it("fixed original seals and ordinary VFS seals open each other's exact bound envelope", async () => {
  const root = await mintVaultKey();
  root.rawVaultKey.fill(0);
  const original = captureOriginalDeviceIdentitySealData(() => {});
  const payload = { v: 1, dataB64: "YWJj" };
  try {
    const seal = await original.seal(root.vaultKey, payload, binding);
    expect(await openJson(root.vaultKey, seal, binding)).toEqual(payload);
    const ordinary = await sealJson(root.vaultKey, payload, binding);
    expect(await original.open(root.vaultKey, ordinary, binding)).toEqual(
      payload,
    );
    await expect(
      original.open(
        root.vaultKey,
        ordinary,
        vaultSealBinding("other", "config/device-identity-key"),
      ),
    ).rejects.toThrow();
    await expect(
      original.open(
        root.vaultKey,
        ordinary,
        vaultSealBinding("personal", "index"),
      ),
    ).rejects.toThrow();
  } finally {
    await original.close();
  }
});
it("owns the submitted plaintext before an accepted original AES encryption awaits", async () => {
  const root = await mintVaultKey();
  root.rawVaultKey.fill(0);
  const entered = gate();
  const delivery = gate();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(
    async (algorithm, key, bytes) => {
      const actual = await encrypt(algorithm, key, bytes);
      entered.release();
      await delivery.promise;
      return actual;
    },
  );
  const original = captureOriginalDeviceIdentitySealData(() => {});
  const payload = { v: 1, dataB64: "YWJj" };
  const pending = original.seal(root.vaultKey, payload, binding);
  const observed = pending.catch(() => undefined);
  try {
    await entered.promise;
    payload.dataB64 = "eHl6";
  } finally {
    delivery.release();
    await observed;
  }
  try {
    const seal = await pending;
    expect(await openJson(root.vaultKey, seal, binding)).toEqual({
      v: 1,
      dataB64: "YWJj",
    });
  } finally {
    await original.close();
  }
});
it.each(["retire", "method"] as const)(
  "accepted actual AES decrypt drains and refuses original %s replacement",
  async (cut) => {
    const root = await mintVaultKey();
    root.rawVaultKey.fill(0);
    const blob = await sealJson(
      root.vaultKey,
      { v: 1, dataB64: "YWJj" },
      binding,
    );
    const entered = gate();
    const delivery = gate();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(
      async (algorithm, key, bytes) => {
        const actual = await decrypt(algorithm, key, bytes);
        entered.release();
        await delivery.promise;
        return actual;
      },
    );
    const controller = new AbortController();
    const original = captureOriginalDeviceIdentitySealData(() => {
      if (controller.signal.aborted)
        throw new Error("Original operation retired.");
    });
    const pending = original.open(root.vaultKey, blob, binding);
    const observed = pending.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (cut === "retire") controller.abort();
      else vi.spyOn(crypto.subtle, "encrypt");
      let closed = false;
      closing = original.close().then(
        () => {
          closed = true;
        },
        () => {
          closed = true;
        },
      );
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      delivery.release();
      await Promise.allSettled([observed, ...(closing ? [closing] : [])]);
      await Promise.allSettled([original.close()]);
    }
    await expect(pending).rejects.toThrow();
    await expect(original.open(root.vaultKey, blob, binding)).rejects.toThrow();
  },
);

it.each(["seal", "open"] as const)(
  "full actual AES %s delivery refuses close at its final accepted handoff",
  async (cut) => {
    const root = await mintVaultKey();
    root.rawVaultKey.fill(0);
    const blob = await sealJson(
      root.vaultKey,
      { v: 1, dataB64: "YWJj" },
      binding,
    );
    let completed = false;
    let armed = true;
    let closing: Promise<void> | undefined;
    let decrypted: ArrayBuffer | undefined;
    if (cut === "seal") {
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
        const result = await encrypt(...args);
        completed = true;
        return result;
      });
    } else {
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
        const result = await decrypt(...args);
        decrypted = result;
        completed = true;
        return result;
      });
    }
    const original = captureOriginalDeviceIdentitySealData(() => {
      if (completed && armed) {
        armed = false;
        queueMicrotask(() => {
          closing = original.close();
          void closing.catch(() => undefined);
        });
      }
    });
    const pending =
      cut === "seal"
        ? original.seal(root.vaultKey, { v: 1, dataB64: "YWJj" }, binding)
        : original.open(root.vaultKey, blob, binding);
    try {
      await expect(pending).rejects.toThrow();
      expect(completed).toBe(true);
      expect(closing).toBeDefined();
      if (cut === "open") {
        if (!decrypted)
          throw new Error("Actual AES decryption was not accepted.");
        expect([...new Uint8Array(decrypted)].every((byte) => byte === 0)).toBe(
          true,
        );
      }
    } finally {
      await Promise.allSettled([
        pending,
        ...(closing ? [closing] : []),
        original.close(),
      ]);
    }
  },
);

it("a bound plaintext accessor's reentrant close drains its reserved seal call without invoking randomness", async () => {
  const root = await mintVaultKey();
  root.rawVaultKey.fill(0);
  const random = vi.spyOn(crypto, "getRandomValues");
  const original = captureOriginalDeviceIdentitySealData(() => {});
  let closing: Promise<void> | undefined;
  let settled = false;
  let observedAtClose: boolean | undefined;
  const payload = { v: 1, dataB64: "YWJj" };
  Object.defineProperty(payload, "dataB64", {
    enumerable: true,
    get: () => {
      if (!closing)
        closing = original.close().then(
          () => {
            observedAtClose = settled;
          },
          () => {
            observedAtClose = settled;
          },
        );
      return "YWJj";
    },
  });
  const pending = original.seal(root.vaultKey, payload, binding);
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await observed;
    if (!closing) throw new Error("Plaintext accessor did not reenter close.");
    await closing;
    expect(observedAtClose).toBe(true);
    expect(random).not.toHaveBeenCalled();
    await expect(pending).rejects.toThrow();
  } finally {
    await Promise.allSettled([
      observed,
      ...(closing ? [closing] : []),
      original.close(),
    ]);
  }
});
