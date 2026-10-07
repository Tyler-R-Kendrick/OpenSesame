import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearActivePresentation,
  readActivePresentation,
} from "../duress/compartment/presentation-runtime.js";
import { unwrapSeams } from "../vault/primary-unwrap.js";
import * as bodyLoader from "../vault/store-body.js";
import { openRetiredCredentialDecoy } from "./session.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}
const trap = {
  id: "selected",
  createdAt: "2026-10-06T00:00:00Z",
  response: "synthetic_decoy" as const,
};
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearActivePresentation();
  fixture.restore();
});

it.each(["lock", "real_reauthentication"])(
  "discards and wipes an actual guest key whose import completes after %s",
  async (interruption) => {
    fixture.store.lock();
    const started = deferred();
    const blocked = deferred();
    let raw: Uint8Array | null = null;
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
      async (format, data, algorithm, extractable, usages) => {
        if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
        else if (ArrayBuffer.isView(data))
          raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const key = await original(
          format,
          data,
          algorithm,
          extractable,
          usages,
        );
        started.finish();
        await blocked.promise;
        return key;
      },
    );
    const pending = fixture.store.createGuest({ decoy: true, isolated: true });
    const result = pending.then(
      () => null,
      (error: Error) => error,
    );
    await started.promise;
    fixture.store.lock();
    if (interruption === "real_reauthentication")
      await fixture.store.unlock(PASSWORD);
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await result).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    expect(fixture.store.getSnapshot().decoy).toBe(false);
    if (!raw) throw new Error("Expected an actual imported raw guest key");
    expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
  },
);

it("does not execute a queued synthetic item write on a freshly authenticated real vault", async () => {
  const owner = createItem("note", "Owner private note");
  owner.notes = "owner-only-secret";
  await fixture.store.saveItem(owner);
  fixture.store.lock();
  await fixture.store.createGuest({ decoy: true, isolated: true });
  const synthetic = createItem("note", "Synthetic queued write");
  const pending = fixture.store.addItems([synthetic]);
  const result = pending.then(
    () => null,
    (error: Error) => error,
  );
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(await result).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: owner.id, notes: owner.notes }),
  );
  expect(
    fixture.store.getSnapshot().items.some((item) => item.id === synthetic.id),
  ).toBe(false);
});

it.each(["createGuest", "addItems"] as const)(
  "withholds a constructor continuation after %s completes and a new real realm is admitted",
  async (stage) => {
    fixture.store.lock();
    const reached = deferred();
    const blocked = deferred();
    if (stage === "createGuest") {
      const original = fixture.store.createGuest.bind(fixture.store);
      vi.spyOn(fixture.store, "createGuest").mockImplementation(
        async (options) => {
          await original(options);
          reached.finish();
          await blocked.promise;
        },
      );
    } else {
      const original = fixture.store.addItems.bind(fixture.store);
      vi.spyOn(fixture.store, "addItems").mockImplementation(async (items) => {
        await original(items);
        reached.finish();
        await blocked.promise;
      });
    }
    const pending = openRetiredCredentialDecoy(fixture.store, trap, "personal");
    const result = pending.then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    fixture.store.lock();
    await fixture.store.unlock(PASSWORD);
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await result).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    expect(readActivePresentation()).toBeNull();
  },
);

it("does not commit or roll back a late synthetic seal into a new real session", async () => {
  const owner = createItem("note", "Owner private note");
  await fixture.store.saveItem(owner);
  fixture.store.lock();
  await fixture.store.createGuest({ decoy: true, isolated: true });
  const reached = deferred();
  const blocked = deferred();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(
    async (algorithm, key, data) => {
      const sealed = await encrypt(algorithm, key, data);
      reached.finish();
      await blocked.promise;
      return sealed;
    },
  );
  const pending = fixture.store.addItems([
    createItem("note", "Synthetic write"),
  ]);
  const result = pending.then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await result).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(current);
  expect(fixture.store.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: owner.id }),
  );
});

it("does not mistake a later synthetic realm for its own guest construction", async () => {
  fixture.store.lock();
  const reached = deferred();
  const blocked = deferred();
  const original = fixture.store.createGuest.bind(fixture.store);
  vi.spyOn(fixture.store, "createGuest").mockImplementationOnce(
    async (options) => {
      await original(options);
      reached.finish();
      await blocked.promise;
    },
  );
  const pending = openRetiredCredentialDecoy(fixture.store, trap, "personal");
  const result = pending.then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  fixture.store.lock();
  await fixture.store.createGuest({ decoy: true, isolated: true });
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await result).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(current);
  expect(readActivePresentation()).toBeNull();
});

it.each(["password", "pin"] as const)(
  "never admits a real root from a blocked %s unwrap after a retired credential opens a synthetic realm",
  async (method) => {
    await fixture.enroll("selected retired password", "synthetic_decoy");
    if (method === "pin") await fixture.store.enrollPin("93746281");
    fixture.store.lock();
    const reached = deferred();
    const blocked = deferred();
    let raw: Uint8Array | null = null;
    if (method === "password") {
      const original = unwrapSeams.password;
      vi.spyOn(unwrapSeams, "password").mockImplementationOnce(
        async (header, password) => {
          raw = await original(header, password);
          reached.finish();
          await blocked.promise;
          return raw;
        },
      );
    } else {
      const original = unwrapSeams.pin;
      vi.spyOn(unwrapSeams, "pin").mockImplementationOnce(
        async (record, pin) => {
          raw = await original(record, pin);
          reached.finish();
          await blocked.promise;
          return raw;
        },
      );
    }
    const pending =
      method === "password"
        ? fixture.store.unlock(PASSWORD)
        : fixture.store.unlockWithPin("93746281");
    const result = pending.then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    await expect(
      unlockWithRetiredCredentialGate(
        fixture.store,
        "selected retired password",
      ),
    ).resolves.toBe("retired_credential_session");
    const synthetic = fixture.store.getSnapshot();
    blocked.finish();
    expect(await result).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(synthetic);
    expect(fixture.store.getSnapshot()).toMatchObject({
      decoy: true,
      guest: true,
    });
    if (!raw) throw new Error("Expected an actual unwrapped real root");
    expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
    expect(() => fixture.store.exportSealed()).toThrow(/authenticate again/);
  },
);

it("withholds a real root import that settles after synthetic admission", async () => {
  await fixture.enroll("selected retired password", "synthetic_decoy");
  fixture.store.lock();
  const reached = deferred();
  const blocked = deferred();
  let interrupted = false;
  let raw: Uint8Array | null = null;
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementation(
    async (format, data, algorithm, extractable, usages) => {
      const key = await original(format, data, algorithm, extractable, usages);
      if (
        !interrupted &&
        usages.includes("encrypt") &&
        usages.includes("decrypt")
      ) {
        interrupted = true;
        if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
        else if (ArrayBuffer.isView(data))
          raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        reached.finish();
        await blocked.promise;
      }
      return key;
    },
  );
  const pending = fixture.store.unlock(PASSWORD);
  const result = pending.then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  await unlockWithRetiredCredentialGate(
    fixture.store,
    "selected retired password",
  );
  const synthetic = fixture.store.getSnapshot();
  blocked.finish();
  expect(await result).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(synthetic);
  if (!raw) throw new Error("Expected an actual real-root import");
  expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
});

it("does not install a real body that finishes loading after lock and synthetic admission", async () => {
  const owner = createItem("note", "Owner private note");
  owner.notes = "owner-only-secret";
  await fixture.store.saveItem(owner);
  await fixture.enroll("selected retired password", "synthetic_decoy");
  fixture.store.lock();
  const reached = deferred();
  const blocked = deferred();
  const original = bodyLoader.loadVaultBody;
  vi.spyOn(bodyLoader, "loadVaultBody").mockImplementationOnce(
    async (...args) => {
      const body = await original(...args);
      expect(body.items).toContainEqual(
        expect.objectContaining({ id: owner.id }),
      );
      reached.finish();
      await blocked.promise;
      return body;
    },
  );
  const pending = fixture.store.unlock(PASSWORD);
  const result = pending.then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  fixture.store.lock();
  await unlockWithRetiredCredentialGate(
    fixture.store,
    "selected retired password",
  );
  const synthetic = fixture.store.getSnapshot();
  blocked.finish();
  expect(await result).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(synthetic);
  expect(JSON.stringify(fixture.store.getSnapshot().items)).not.toContain(
    "owner-only-secret",
  );
});
