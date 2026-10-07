import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../../host.js";
import { isSealedAtRest } from "../../lib/at-rest/cipher.js";
import { openOriginFile } from "../../lib/at-rest/origin-files.js";
import {
  contextSchema,
  presentedIdSchema,
} from "../../lib/credential-canaries/protocol.js";
import {
  canaryRegistryKey,
  readCanaryRegistry,
} from "../../lib/credential-canaries/storage.js";
import {
  outboxKey,
  readReceiverConfig,
  receiverKey,
} from "../../lib/credential-observation/storage.js";
import { publicVectorProvision } from "../../lib/credential-observation/vector-test-support.js";
import {
  kvDurability,
  kvFileName,
  kvFlush,
  kvForgetFiles,
  kvSeams,
} from "../../lib/kv.js";
import { retiredCredentialStorageSeams } from "../../lib/retired-credentials/credential-lock.js";
import { vaultStore } from "../../lib/vault/store.js";
import { createTestHost } from "../../test-host.js";
import { ExtensionRealmBroker } from "../security/broker.js";
import * as core from "../security/core.js";
import { deferred } from "../security/management.fixture.js";
import { manageExtensionSecurity } from "../security/management.js";
import {
  holdGenuineRead,
  persistentBrowserOwner,
  persistentManagementBridge,
} from "./management-host.fixture.js";
let f: Awaited<ReturnType<typeof persistentBrowserOwner>>;
const releases: Array<() => void> = [];
let bridge: ReturnType<typeof persistentManagementBridge>;
beforeEach(async () => {
  f = await persistentBrowserOwner();
  bridge = persistentManagementBridge();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  bridge?.close();
  await bridge?.drain();
  vaultStore.lock();
  await kvFlush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
function pairing(bindingId = "first-controlled-binding") {
  return JSON.stringify({
    ...publicVectorProvision(),
    bindingId,
    origin: "https://controlled.example",
    allowLoopback: false,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}
async function actualUnlock() {
  await expect(bridge.client.unlock(f.password)).resolves.toMatchObject({
    realm: "real",
  });
  expect(bridge.client.permit()).toBeDefined();
}
it("commits genuine owner canary data through the worker into browser-IDB-key-sealed OPFS, surviving fresh readback", async () => {
  await actualUnlock();
  const raw = await bridge.client.manage(
    { verb: "canary-create", kind: "connection_ref" },
    f.password,
  );
  const response = z
    .object({
      artifact: z
        .object({
          id: z.string().uuid(),
          context: contextSchema,
          presentedId: presentedIdSchema,
        })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(raw));
  const file = kvFileName(canaryRegistryKey("personal"));
  const ciphertext = f.root.files.get(file);
  expect(kvDurability()).toBe("persistent");
  expect(ciphertext).toBeDefined();
  if (!ciphertext) throw new Error("Missing durable canary seal");
  expect(isSealedAtRest(ciphertext)).toBe(true);
  expect(ciphertext).not.toContain(response.artifact.presentedId);
  const opened = await openOriginFile(file, ciphertext);
  expect(opened).toContain(response.artifact.id);
  expect(opened).not.toContain(response.artifact.presentedId);
  kvForgetFiles(new Set([file]));
  const read = await readCanaryRegistry("personal");
  expect(read.artifacts).toHaveLength(1);
  expect(read.artifacts[0]?.id).toBe(response.artifact.id);
  expect(read.vaultIdentity).toBe(f.header?.protection?.vaultId);
});
it("commits disabled unverified independent receiver pairing encrypted at rest without transmitting it", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  await actualUnlock();
  await bridge.client.manage(
    { verb: "receiver-configure", pairingJson: pairing() },
    f.password,
  );
  const name = kvFileName(receiverKey("personal"));
  const ciphertext = f.root.files.get(name);
  if (!ciphertext) throw new Error("Missing durable receiver seal");
  expect(isSealedAtRest(ciphertext)).toBe(true);
  expect(ciphertext).not.toContain(
    publicVectorProvision().independentKeyMaterialB64,
  );
  const opened = await openOriginFile(name, ciphertext);
  expect(opened).toContain("first-controlled-binding");
  kvForgetFiles(new Set([name]));
  expect(await readReceiverConfig("personal")).toMatchObject({
    enabled: false,
    verified: false,
    vaultIdentity: f.header?.protection?.vaultId,
    provision: { bindingId: "first-controlled-binding" },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["lock", "close", "expiry"] as const)(
  "prevents actual canary persistence after %s while its delegated genuine registry read is pending",
  async (interruption) => {
    await actualUnlock();
    const started = deferred<void>();
    const resume = deferred<void>();
    releases.push(() => resume.finish());
    const refresh = retiredCredentialStorageSeams.refresh;
    let armed = true;
    vi.spyOn(retiredCredentialStorageSeams, "refresh").mockImplementation(
      async (key, maxBytes) => {
        await refresh(key, maxBytes);
        if (armed && key === canaryRegistryKey("personal")) {
          armed = false;
          started.finish();
          await resume.promise;
        }
      },
    );
    const durable = kvSeams.kvSetDurable;
    const commits: string[] = [];
    vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
      await durable(key, value);
      if (key === canaryRegistryKey("personal")) commits.push(value);
    });
    const pending = Promise.allSettled([
      bridge.client.manage(
        { verb: "canary-create", kind: "connection_ref" },
        f.password,
      ),
    ]);
    await started.promise;
    if (interruption === "lock") bridge.client.lock();
    if (interruption === "close") bridge.close();
    if (interruption === "expiry") bridge.clock.now += 300000;
    resume.finish();
    await bridge.drain();
    expect((await pending)[0]?.status).toBe("rejected");
    expect(commits).toHaveLength(0);
    expect((await readCanaryRegistry("personal")).artifacts).toHaveLength(0);
    expect(f.root.files.has(kvFileName(canaryRegistryKey("personal")))).toBe(
      false,
    );
    if (interruption !== "close") {
      await actualUnlock();
      await bridge.client.manage(
        { verb: "canary-create", kind: "connection_ref" },
        f.password,
      );
      expect(commits).toHaveLength(1);
    }
  },
);
it("keeps the previous genuinely sealed receiver configuration when public lease lock interrupts actual outbox read", async () => {
  await actualUnlock();
  await bridge.client.manage(
    { verb: "receiver-configure", pairingJson: pairing() },
    f.password,
  );
  const name = kvFileName(receiverKey("personal"));
  const previous = f.root.files.get(name);
  const gate = holdGenuineRead(f.root, kvFileName(outboxKey("personal")));
  releases.push(gate.release);
  const pending = Promise.allSettled([
    bridge.client.manage(
      {
        verb: "receiver-configure",
        pairingJson: pairing("replacement-binding"),
      },
      f.password,
    ),
  ]);
  await gate.started;
  bridge.client.lock();
  gate.release();
  await bridge.drain();
  expect((await pending)[0]?.status).toBe("rejected");
  expect(f.root.files.get(name)).toBe(previous);
  kvForgetFiles(new Set([name]));
  expect(await readReceiverConfig("personal")).toMatchObject({
    provision: { bindingId: "first-controlled-binding" },
  });
});
it.each([false, true])(
  "revokes management before its actual owner unlock when a successful genuine classification is superseded (lock first=%s)",
  async (lockFirst) => {
    await actualUnlock();
    const original = bridge.client.permit();
    const classify = core.classifyExtensionPassword;
    const started = deferred<void>();
    const resume = deferred<void>();
    let armed = true;
    releases.push(() => resume.finish());
    vi.spyOn(core, "classifyExtensionPassword").mockImplementation(
      async (password) => {
        const proof = await classify(password);
        if (armed) {
          armed = false;
          started.finish();
          await resume.promise;
        }
        return proof;
      },
    );
    const unlock = vi.spyOn(vaultStore, "unlock");
    const pending = Promise.allSettled([
      bridge.client.manage(
        { verb: "canary-create", kind: "connection_ref" },
        f.password,
      ),
    ]);
    await started.promise;
    if (lockFirst) bridge.client.lock();
    await actualUnlock();
    const successor = bridge.client.permit();
    expect(successor).not.toBe(original);
    resume.finish();
    await bridge.drain();
    expect((await pending)[0]?.status).toBe("rejected");
    expect(unlock).not.toHaveBeenCalled();
    expect((await readCanaryRegistry("personal")).artifacts).toHaveLength(0);
    expect(bridge.client.permit()).toBe(successor);
    await expect(bridge.client.authorize()).resolves.toBe(true);
  },
);
it("does not forward any newly entered owner password or pairing to a disconnected production management transport", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  await actualUnlock();
  bridge.close();
  const requests = bridge.sent.length;
  const privateInput = crypto.randomUUID();
  const payload = pairing();
  await expect(
    bridge.client.manage(
      { verb: "receiver-configure", pairingJson: payload },
      privateInput,
    ),
  ).rejects.toThrow();
  expect(bridge.sent).toHaveLength(requests);
  expect(JSON.stringify(bridge.sent)).not.toContain(privateInput);
  expect(f.root.files.has(kvFileName(receiverKey("personal")))).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("withholds genuinely computed owner metadata when its port closes in the final authorization helper-return gap", async () => {
  let completed = 0;
  const broker = new ExtensionRealmBroker({
    revision: core.extensionVaultRevision,
    classify: core.classifyExtensionPassword,
    now: Date.now,
    manage: async (operation, password, check) => {
      const result = await manageExtensionSecurity(operation, password, check);
      completed += 1;
      return result;
    },
  });
  const owner = broker.attach();
  const peer = broker.attach();
  try {
    const original = await owner.handle({
      id: 1,
      op: "unlock",
      password: f.password,
    });
    const successor = await peer.handle({
      id: 2,
      op: "unlock",
      password: f.password,
    });
    if (!original.permit || !successor.permit)
      throw new Error("Expected genuinely classified independent real permits");
    const request = {
      id: 3,
      op: "manage" as const,
      permit: original.permit,
      password: f.password,
      operation: { verb: "canary-status" as const },
    };
    const positive = await owner.handle(request);
    expect(positive.realm).toBe("real");
    expect(positive.resultJson).toBeDefined();
    expect(completed).toBe(1);
    const allows = broker.allows.bind(broker);
    let authorizations = 0;
    let originalVerdict = false;
    vi.spyOn(broker, "allows").mockImplementation(async (permit) => {
      const allowed = await allows(permit);
      authorizations += 1;
      if (authorizations === 2) {
        originalVerdict = allowed;
        queueMicrotask(() => owner.close());
      }
      return allowed;
    });
    const rejected = await owner.handle({ ...request, id: 4 });
    expect(originalVerdict).toBe(true);
    expect(completed).toBe(2);
    expect(rejected.realm).toBe("locked");
    expect(rejected.resultJson).toBeUndefined();
    await expect(
      peer.handle({ id: 5, op: "authorize", permit: successor.permit }),
    ).resolves.toMatchObject({ realm: "real" });
  } finally {
    owner.close();
    peer.close();
  }
});
