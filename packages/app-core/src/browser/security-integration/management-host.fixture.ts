import type { BoundaryValue } from "@opensesame/os-domain";
import {
  importVaultKey,
  openJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { expect, vi } from "vitest";
import { composeHost, configureHost } from "../../host.js";
import { webLocksDouble } from "../../lib/__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "../../lib/at-rest/key.js";
import { makeOpfs } from "../../lib/duress/wipe/fake-opfs.test-support.js";
import { kvFlush, kvForgetAll } from "../../lib/kv.js";
import { verifyManifestAuth } from "../../lib/vault/protection/manifest-auth.js";
import { vaultStore } from "../../lib/vault/store.js";
import { readSealedFile } from "../../lib/vfs.js";
import { createMemoryStorage } from "../../memory-storage.js";
import { browserPorts } from "../host.js";
import {
  ExtensionRealmBroker,
  SECURITY_PORT,
  type SecurityRequest,
} from "../security/broker.js";
import { type PageRuntime, securityClient } from "../security/client.js";
import * as core from "../security/core.js";
import { deferred } from "../security/management.fixture.js";
import { manageExtensionSecurity } from "../security/management.js";

/** Only physical browser APIs are doubled; the actual browser adapter owns cryptography and storage. */
export async function persistentBrowserOwner() {
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  const root = makeOpfs();
  const locks = webLocksDouble();
  const factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  vi.stubGlobal("navigator", {
    locks,
    storage: { getDirectory: async () => root },
    onLine: false,
  });
  await core.initializeExtensionVault();
  // The initializer is intentionally one-shot. Subsequent independent test origins
  // install the same genuine browser composition, never a test Host/key store.
  configureHost(
    composeHost(browserPorts(), { env: { BASE_URL: "/", DEV: false } }),
  );
  vaultStore.rehydrate();
  vaultStore.loadActiveProjectScope();
  const password = crypto.randomUUID();
  await vaultStore.create(password);
  const header = vaultStore.getSnapshot().header;
  if (!header?.protection)
    throw new Error("Expected authenticated owner header");
  const raw = await unwrapRawVaultKeyFromPassword(header, password);
  try {
    await verifyManifestAuth(raw, header.protection);
    const body = readSealedFile("personal", "body");
    if (!body) throw new Error("Expected encrypted owner body");
    await openJson(
      await importVaultKey(raw),
      body,
      vaultSealBinding("personal", "body"),
    );
  } finally {
    raw.fill(0);
  }
  expect(header.protection.authB64).toBeDefined();
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
  });
  vaultStore.lock();
  return { root, locks, factory, password, header };
}

/** All verdicts, permits, fresh-owner ceremonies and worker replies come from production code. */
export function persistentManagementBridge() {
  const clock = { now: Date.now() };
  const broker = new ExtensionRealmBroker({
    revision: core.extensionVaultRevision,
    classify: (password) => core.classifyExtensionPassword(password),
    now: () => clock.now,
    manage: manageExtensionSecurity,
  });
  const owner = broker.attach();
  const sent: SecurityRequest[] = [];
  const pending = new Set<Promise<unknown>>();
  let connected = true;
  let message: (value: BoundaryValue) => void = () => {};
  let disconnect = () => {};
  const close = () => {
    connected = false;
    owner.close();
    disconnect();
  };
  const runtime: PageRuntime = {
    connect: (options) => {
      expect(options).toEqual({ name: SECURITY_PORT });
      return {
        postMessage: (request) => {
          if (!connected) throw new Error("Actual test transport is closed");
          sent.push(request);
          const work = owner.handle(request);
          pending.add(work);
          void work.then(
            (reply) => {
              pending.delete(work);
              if (connected) message(reply);
            },
            () => {
              pending.delete(work);
              close();
            },
          );
        },
        onMessage: {
          addListener: (listener) => {
            message = listener;
          },
        },
        onDisconnect: {
          addListener: (listener) => {
            disconnect = listener;
          },
        },
      };
    },
  };
  const client = securityClient(runtime, () => {});
  return {
    runtime,
    client,
    clock,
    sent,
    close,
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
export function holdGenuineRead(
  root: ReturnType<typeof makeOpfs>,
  target: string,
) {
  const started = deferred<void>();
  const resume = deferred<void>();
  const original = root.getFileHandle.bind(root);
  let armed = true;
  vi.spyOn(root, "getFileHandle").mockImplementation(async (name, options) => {
    const handle = await original(name, options);
    if (name !== target || !armed || options?.create) return handle;
    armed = false;
    const getFile = handle.getFile.bind(handle);
    return {
      ...handle,
      getFile: async () => {
        const file = await getFile();
        return {
          ...file,
          text: async () => {
            const ciphertext = await file.text();
            started.finish();
            await resume.promise;
            return ciphertext;
          },
        };
      },
    };
  });
  return { started: started.promise, release: () => resume.finish() };
}
