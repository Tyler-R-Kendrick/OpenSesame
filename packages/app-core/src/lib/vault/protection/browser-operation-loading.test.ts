/** Holds original Vite module delivery; no module exports are replaced. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createViteServer } from "vitest/node";
import { z } from "zod";
import originalConfig from "../../../../vitest.config.js";
import { type Host, configureHost, host } from "../../../host.js";
import type { VaultStore } from "../store.js";
import { deliveryGate } from "./browser-operation-loading.fixture.js";

type Realm = typeof import("./browser-operation-loading.realm.js");
const originalCallable = z.function();
const originalPrototype = z.object({
  create: z.custom<Realm["VaultStore"]["prototype"]["create"]>(
    (value) => originalCallable.safeParse(value).success,
  ),
  unlock: z.custom<Realm["VaultStore"]["prototype"]["unlock"]>(
    (value) => originalCallable.safeParse(value).success,
  ),
  saveItem: z.custom<Realm["VaultStore"]["prototype"]["saveItem"]>(
    (value) => originalCallable.safeParse(value).success,
  ),
  createGuest: z.custom<Realm["VaultStore"]["prototype"]["createGuest"]>(
    (value) => originalCallable.safeParse(value).success,
  ),
});
const originalRealmSchema = z
  .object({
    prepare: z.custom<Realm["prepare"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    reset: z.custom<Realm["reset"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    header: z.custom<Realm["header"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    body: z.custom<Realm["body"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    vfsFlush: z.custom<Realm["vfsFlush"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    createItem: z.custom<Realm["createItem"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    VaultStore: z
      .custom<Realm["VaultStore"]>(
        (value) => originalCallable.safeParse(value).success,
      )
      .refine((vault) => originalPrototype.safeParse(vault.prototype).success),
    isDecoySession: z.custom<Realm["isDecoySession"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    assertOwnedStorageWrites: z.custom<Realm["assertOwnedStorageWrites"]>(
      (value) => originalCallable.safeParse(value).success,
    ),
    wipeGuard: z
      .object({
        forbid: z.custom<Realm["wipeGuard"]["forbid"]>(
          (value) => originalCallable.safeParse(value).success,
        ),
        allow: z.custom<Realm["wipeGuard"]["allow"]>(
          (value) => originalCallable.safeParse(value).success,
        ),
        permits: z.custom<Realm["wipeGuard"]["permits"]>(
          (value) => originalCallable.safeParse(value).success,
        ),
        takeReached: z.custom<Realm["wipeGuard"]["takeReached"]>(
          (value) => originalCallable.safeParse(value).success,
        ),
      })
      .strict(),
  })
  .strict();
const delivery = { enrollment: deliveryGate(), lifecycle: deliveryGate() };
let server: Awaited<ReturnType<typeof createViteServer>>;
let realm: Realm;
let cacheDir: string | undefined;
const stores: VaultStore[] = [];
let priorHost: Host | undefined;
type HeldOperation =
  | ReturnType<VaultStore["protection"]["enrollCandidate"]>
  | ReturnType<VaultStore["protection"]["testProtector"]>
  | Promise<void>;
type Delivery = ReturnType<typeof deliveryGate>;
const heldOperations: { operation: HeldOperation; gate: Delivery }[] = [];

function trackHeld<T extends HeldOperation>(operation: T, gate: Delivery): T {
  heldOperations.push({ operation, gate });
  return operation;
}

const PASSWORD = "correct horse battery staple";

beforeAll(async () => {
  priorHost = host();
  cacheDir = await mkdtemp(join(tmpdir(), "opensesame-protector-loader-"));
  server = await createViteServer({
    ...originalConfig,
    configFile: false,
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    cacheDir,
    server: { middlewareMode: true, watch: null, hmr: false },
    plugins: [
      {
        name: "hold-original-protector-delivery",
        async load(id) {
          const gate = id.endsWith("/protection/browser-enroll.ts")
            ? delivery.enrollment
            : id.endsWith("/protection/browser-lifecycle-ops.ts")
              ? delivery.lifecycle
              : null;
          if (gate) {
            gate.announce();
            await gate.held;
          }
          // Delegate untouched source to the ordinary Vite loaders.
          return null;
        },
      },
    ],
  });
  const loaded: unknown = await server.ssrLoadModule(
    fileURLToPath(
      new URL("./browser-operation-loading.realm.ts", import.meta.url),
    ),
  );
  const originalFunctions = originalRealmSchema.parse(loaded);
  // Parsing validates only original function identities; no function is wrapped.
  realm = originalFunctions;
  await realm.prepare();
  realm.wipeGuard.forbid();
});

async function closeHarness(): Promise<void> {
  try {
    await server?.close();
  } finally {
    try {
      if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    } finally {
      if (priorHost) configureHost(priorHost);
    }
  }
}

afterAll(async () => {
  try {
    await drainHeldOperations();
  } finally {
    await closeHarness();
  }
});

async function owner(): Promise<VaultStore> {
  const store = new realm.VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  await store.protection.ensureProtectionProjected();
  return store;
}

function passwordId(store: VaultStore): string {
  const record = store.protection
    .listProtectors()
    .find((entry) => entry.kind === "password");
  if (!record) throw new Error("The genuine owner has no password protector.");
  return record.protectorId;
}

beforeEach(async () => {
  await realm.reset();
});

async function drainHeldOperations(): Promise<void> {
  const pending = heldOperations.splice(0);
  for (const { gate } of pending) gate.releaseEntered();
  if (delivery.enrollment.loads() > 0) delivery.enrollment.releaseEntered();
  if (delivery.lifecycle.loads() > 0) delivery.lifecycle.releaseEntered();
  try {
    for (const store of stores.splice(0)) store.lock();
  } finally {
    await Promise.allSettled(pending.map(({ operation }) => operation));
    if (realm) {
      await realm.vfsFlush();
      realm.assertOwnedStorageWrites();
      expect(realm.wipeGuard.takeReached()).toEqual([]);
    }
  }
  expect(delivery.enrollment.loads()).toBeLessThanOrEqual(1);
  expect(delivery.lifecycle.loads()).toBeLessThanOrEqual(1);
}

afterEach(drainHeldOperations);

describe.sequential(
  "deferred protector management with real owner sessions",
  () => {
    it("does not admit a cold enrollment into a fresh owner session after lock", async () => {
      const store = await owner();
      const before = realm.header();
      const pending = trackHeld(
        store.protection.enrollCandidate("recovery-key"),
        delivery.enrollment,
      );
      const refused = expect(pending).rejects.toMatchObject({
        code: "stale_operation",
      });
      await delivery.enrollment.entered;
      store.lock();
      await store.unlock(PASSWORD);
      delivery.enrollment.release();
      await refused;
      expect(realm.header()).toBe(before);
      expect(
        store.protection
          .listProtectors()
          .some((entry) => entry.kind === "recovery-key"),
      ).toBe(false);
      const fresh = await store.protection.enrollCandidate("recovery-key");
      await store.protection.commitEnrollment(fresh.operationId);
      expect(
        store.protection
          .listProtectors()
          .some((entry) => entry.protectorId === fresh.record.protectorId),
      ).toBe(true);
    });

    it("does not delegate a cold lifecycle operation into a synthetic session", async () => {
      const store = await owner();
      const beforeHeader = realm.header();
      const beforeBody = realm.body();
      const pending = trackHeld(
        store.protection.setPreferred(passwordId(store)),
        delivery.lifecycle,
      );
      const refused = expect(pending).rejects.toMatchObject({
        code: "stale_operation",
      });
      await delivery.lifecycle.entered;
      store.lock();
      await store.createGuest({ decoy: true });
      expect(realm.isDecoySession()).toBe(true);
      delivery.lifecycle.release();
      await refused;
      expect(store.protection.listProtectors()).toEqual([]);
      expect(realm.header()).toBe(beforeHeader);
      expect(realm.body()).toBe(beforeBody);
    });

    it("uses the cached operations for genuine enrollment, proof, removal and rotation", async () => {
      const store = await owner();
      expect(delivery.enrollment.loads()).toBe(1);
      expect(delivery.lifecycle.loads()).toBe(1);
      const item = realm.createItem("note", "kept across root rotation");
      item.notes = "genuine encrypted payload";
      await store.saveItem(item);
      const enrollment = await store.protection.enrollCandidate("recovery-key");
      const secret = enrollment.recoverySecretB64;
      if (!secret)
        throw new Error("The genuine recovery enrollment returned no secret.");
      await store.protection.commitEnrollment(enrollment.operationId);
      const tested = await store.protection.testProtector(
        enrollment.record.protectorId,
        {
          recoverySecretB64: secret,
        },
      );
      expect(tested).toMatchObject({ proofStatus: "verified" });
      await store.protection.setPreferred(enrollment.record.protectorId);
      expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
        enrollment.record.protectorId,
      );
      await store.protection.removeProtector(enrollment.record.protectorId);
      expect(
        store.getSnapshot().header?.protection?.preferredProtectorId,
      ).toBeUndefined();
      const epoch = store.getSnapshot().header?.protection?.rootEpoch;
      if (epoch === undefined)
        throw new Error("The owner has no authenticated root epoch.");
      await store.protection.rotateCompromisedRoot({ password: PASSWORD });
      expect(store.getSnapshot().header?.protection?.rootEpoch).toBe(epoch + 1);
      store.lock();
      await store.unlock(PASSWORD);
      expect(
        store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
      ).toBe(item.notes);
    });

    it("refuses cached operations from the original generation even after fresh real unlock", async () => {
      const store = await owner();
      const recovery = await store.protection.enrollCandidate("recovery-key");
      const secret = recovery.recoverySecretB64;
      if (!secret)
        throw new Error("The genuine recovery enrollment returned no secret.");
      await store.protection.commitEnrollment(recovery.operationId);
      const before = realm.header();
      const beforeBody = realm.body();
      expect(beforeBody).not.toBeNull();
      const pending = [
        trackHeld(
          store.protection.setPreferred(recovery.record.protectorId),
          delivery.lifecycle,
        ),
        trackHeld(
          store.protection.removeProtector(recovery.record.protectorId),
          delivery.lifecycle,
        ),
        trackHeld(
          store.protection.testProtector(recovery.record.protectorId, {
            recoverySecretB64: secret,
          }),
          delivery.lifecycle,
        ),
        trackHeld(
          store.protection.rotateCompromisedRoot({ password: PASSWORD }),
          delivery.lifecycle,
        ),
        trackHeld(
          store.protection.enrollCandidate("recovery-key"),
          delivery.enrollment,
        ),
      ];
      const refusals = pending.map((operation) =>
        expect(operation).rejects.toMatchObject({ code: "stale_operation" }),
      );
      store.lock();
      await store.unlock(PASSWORD);
      await Promise.all(refusals);
      expect(realm.header()).toBe(before);
      expect(realm.body()).toBe(beforeBody);
      await store.protection.setPreferred(passwordId(store));
      expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
        passwordId(store),
      );
    });
  },
);
