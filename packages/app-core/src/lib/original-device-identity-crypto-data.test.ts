/** Real P-256 generation/signature verification with retained method delivery; no physical or Store claim. */
import { afterEach, expect, it, vi } from "vitest";
import {
  p256JwkThumbprint,
  trustedDeviceKey,
} from "./device-identity-trust.js";
import { captureOriginalDeviceIdentityCryptoData } from "./original-device-identity-crypto-data.js";
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => vi.restoreAllMocks());

it("mints and proves a genuine private/public pair with the original canonical thumbprint", async () => {
  const original = captureOriginalDeviceIdentityCryptoData(() => {});
  try {
    const record = await original.mint();
    expect(await p256JwkThumbprint(record.publicJwk)).toBe(record.keyId);
    expect(await trustedDeviceKey(record)).toEqual(record);
    expect(await original.trusted(record)).toEqual(record);
    expect(
      await original.trusted({ ...record, keyId: "x".repeat(43) }),
    ).toBeNull();
    const other = await original.mint();
    const substituted = { ...record, privateJwkJson: other.privateJwkJson };
    expect(await original.trusted(substituted)).toBeNull();
  } finally {
    await original.close();
  }
});

it("owns a submitted record before its accepted SHA-256 await", async () => {
  const generated = captureOriginalDeviceIdentityCryptoData(() => {});
  const record = await generated.mint();
  await generated.close();
  const entered = gate();
  const delivery = gate();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, bytes) => {
      const actual = await digest(algorithm, bytes);
      entered.release();
      await delivery.promise;
      return actual;
    },
  );
  const original = captureOriginalDeviceIdentityCryptoData(() => {});
  const mutable = { ...structuredClone(record) };
  const pending = original.trusted(mutable);
  const observed = pending.catch(() => undefined);
  try {
    await entered.promise;
    mutable.privateJwkJson = "{}";
  } finally {
    delivery.release();
    await observed;
  }
  try {
    expect(await pending).toEqual(record);
  } finally {
    await original.close();
  }
});

it.each(["retire", "method"] as const)(
  "drains accepted actual P-256 before close after original %s changes",
  async (cut) => {
    const entered = gate();
    const delivery = gate();
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "generateKey").mockImplementation(
      async (algorithm, extractable, usages) => {
        const actual = await generate(algorithm, extractable, usages);
        entered.release();
        await delivery.promise;
        return actual;
      },
    );
    const controller = new AbortController();
    const original = captureOriginalDeviceIdentityCryptoData(() => {
      if (controller.signal.aborted) throw new Error("Original Store retired.");
    });
    const pending = original.mint();
    const observed = pending.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (cut === "retire") controller.abort();
      else vi.spyOn(crypto.subtle, "exportKey");
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
    await expect(original.mint()).rejects.toThrow();
  },
);

it("refuses a changed sign method before any accepted original signing call", async () => {
  const generated = captureOriginalDeviceIdentityCryptoData(() => {});
  const record = await generated.mint();
  await generated.close();
  const original = captureOriginalDeviceIdentityCryptoData(() => {});
  const altered = vi.spyOn(crypto.subtle, "sign");
  await expect(original.trusted(record)).rejects.toThrow(/method changed/);
  expect(altered).not.toHaveBeenCalled();
  await original.close();
});

it("retires at the final actual verify handoff and drains the entire trusted call before close", async () => {
  const generated = captureOriginalDeviceIdentityCryptoData(() => {});
  const record = await generated.mint();
  await generated.close();
  let verified = false;
  let armed = true;
  let closing: Promise<void> | undefined;
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    const actual = await verify(...args);
    verified = true;
    return actual;
  });
  const original = captureOriginalDeviceIdentityCryptoData(() => {
    if (verified && armed) {
      armed = false;
      queueMicrotask(() => {
        closing = original.close();
        void closing.catch(() => undefined);
      });
    }
  });
  const pending = original.trusted(record);
  try {
    await expect(pending).rejects.toThrow();
    expect(verified).toBe(true);
    expect(closing).toBeDefined();
  } finally {
    await Promise.allSettled([
      pending,
      ...(closing ? [closing] : []),
      original.close(),
    ]);
  }
});

it("an actual genuine input accessor's reentrant close waits this same reserved public trust call", async () => {
  const generator = captureOriginalDeviceIdentityCryptoData(() => {});
  const record = await generator.mint();
  await generator.close();
  const original = captureOriginalDeviceIdentityCryptoData(() => {});
  let closing: Promise<void> | undefined;
  let settled = false;
  let observedAtClose: boolean | undefined;
  const input = { ...record };
  Object.defineProperty(input, "publicJwk", {
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
      return record.publicJwk;
    },
  });
  const pending = original.trusted(input);
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
    if (!closing)
      throw new Error("Genuine input accessor did not reenter close.");
    await closing;
    expect(observedAtClose).toBe(true);
    await expect(pending).rejects.toThrow();
  } finally {
    await Promise.allSettled([
      observed,
      ...(closing ? [closing] : []),
      original.close(),
    ]);
  }
});
