import { createItem, readVaultFile } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { vaultStore } from "../vault/store.js";
import {
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./backup-transfer.js";
import {
  openRemoteStore,
  remoteEncryptionKey,
  remoteStore,
  sealRemoteStore,
} from "./encrypted-remote-codec.js";
import {
  EncryptedRemoteConflictError,
  createEncryptedRemoteBackend,
} from "./encrypted-remote.js";
import {
  BEARER_TOKEN,
  ENCRYPTION_KEY,
  ITEM_ID,
  encryptedRemoteFixture,
  freshLocalVault,
  independentOpen,
  independentSeal,
  initialStore,
} from "./encrypted-remote.test-support.js";
import { runtimePassword } from "./runtime.test-support.js";
const closes: (() => Promise<void>)[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
});
async function setup() {
  const fixture = await encryptedRemoteFixture();
  closes.push(fixture.close);
  return {
    ...fixture,
    backend: createEncryptedRemoteBackend(fixture.transport),
  };
}
it("reads independently encrypted remote notes and performs real encrypted login CRUD/list/getNotes", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  expect(await f.backend.getNotes(ITEM_ID, session)).toBe(
    "Independently encrypted original note",
  );
  const input = {
    kind: "login" as const,
    name: "Private project account",
    notes: "Hidden account notes",
    secret: "Hidden account password",
    username: "private-user",
    url: "https://account.example",
  };
  const created = await f.backend.createItem?.(input, session);
  if (!created) throw new Error("Missing real create operation");
  expect(await f.backend.getItem(created.id, session)).toEqual(created);
  expect(await f.backend.listItems(session)).toContainEqual({
    id: created.id,
    name: input.name,
    kind: "login",
  });
  const updated = await f.backend.updateItem?.(
    created.id,
    { ...input, notes: "Actual updated encrypted notes" },
    session,
  );
  expect(await f.backend.getNotes(created.id, session)).toBe(updated?.notes);
  expect(independentOpen(f.state.bytes, f.config.objectUrl)).toMatchObject({
    revision: 3,
    items: expect.arrayContaining([updated]),
  });
  await f.backend.deleteItem?.(created.id, session);
  expect(await f.backend.listItems(session)).toEqual([
    { id: ITEM_ID, name: "Independent fixture note", kind: "note" },
  ]);
  expect(independentOpen(f.state.bytes, f.config.objectUrl)).toMatchObject({
    revision: 4,
  });
  for (const request of f.requests) {
    expect(request.authorization).toBe(`Bearer ${BEARER_TOKEN}`);
    for (const plaintext of [
      ENCRYPTION_KEY,
      input.name,
      input.notes,
      input.secret,
      input.username,
    ])
      expect(request.body).not.toContain(plaintext);
    if (request.method === "PUT") {
      expect(request.match).toMatch(/^"/);
      expect(request.noneMatch).toBe("");
    }
  }
  expect(JSON.stringify(session)).not.toContain(ENCRYPTION_KEY);
});
it("only explicit initialization creates a fresh store with If-None-Match and verifies it by a real read", async () => {
  const f = await setup();
  f.state.missing = true;
  await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
    code: "not-found",
  });
  expect(f.requests.map((row) => row.method)).toEqual(["GET"]);
  const session = await f.backend.initialize(f.config);
  expect(await f.backend.listItems(session)).toEqual([]);
  expect(f.requests[1]).toMatchObject({
    method: "PUT",
    noneMatch: "*",
    match: "",
  });
  expect(independentOpen(f.state.bytes, f.config.objectUrl)).toMatchObject({
    storeId: f.config.storeId,
    revision: 1,
    items: [],
  });
  const before = f.state.bytes;
  await expect(f.backend.initialize(f.config)).rejects.toBeInstanceOf(
    EncryptedRemoteConflictError,
  );
  expect(f.state.bytes).toBe(before);
});
it("a wrong key cannot authenticate, initialize over existing data, or change the remote object", async () => {
  const f = await setup();
  const before = f.state.bytes;
  const wrong = {
    ...f.config,
    encryptionKey: Buffer.alloc(32, 18).toString("base64"),
  };
  await expect(f.backend.authenticate(wrong)).rejects.toThrow("does not match");
  expect(f.requests.map((row) => row.method)).toEqual(["GET"]);
  await expect(f.backend.initialize(wrong)).rejects.toBeInstanceOf(
    EncryptedRemoteConflictError,
  );
  expect(f.state.bytes).toBe(before);
});
it.each(["weak", "omitEtag"] as const)(
  "requires actual strong conditional object support: %s",
  async (flag) => {
    const f = await setup();
    f.state[flag] = true;
    const before = f.state.bytes;
    await expect(f.backend.authenticate(f.config)).rejects.toThrow(
      "strong ETag",
    );
    expect(f.state.bytes).toBe(before);
    expect(f.requests.every((row) => row.method === "GET")).toBe(true);
  },
);
it("concurrent real conditional PUTs preserve exactly one winner and the loser never retries blindly", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  f.state.holdPut = true;
  const results = Promise.allSettled([
    f.backend.createItem?.(
      { name: "Writer A", notes: "A", secret: "" },
      session,
    ),
    f.backend.createItem?.(
      { name: "Writer B", notes: "B", secret: "" },
      session,
    ),
  ]);
  operations.push(results);
  await f.entered.promise;
  f.release.resolve();
  const settled = await results;
  expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  const rejected = settled.find((row) => row.status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: expect.any(EncryptedRemoteConflictError),
  });
  expect(f.requests.filter((row) => row.method === "PUT")).toHaveLength(2);
  expect(independentOpen(f.state.bytes, f.config.objectUrl)).toMatchObject({
    revision: 2,
    items: expect.arrayContaining([expect.objectContaining({ id: ITEM_ID })]),
  });
  expect(await f.backend.listItems(session)).toHaveLength(2);
});
it("a remote412 preserves its current ciphertext, including deletion races", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  const before = f.state.bytes;
  f.state.conflict = true;
  await expect(f.backend.deleteItem?.(ITEM_ID, session)).rejects.toBeInstanceOf(
    EncryptedRemoteConflictError,
  );
  expect(f.state.bytes).toBe(before);
  expect(f.requests.filter((row) => row.method === "PUT")).toHaveLength(1);
});
it("session high-water checks reject replay and same-revision ciphertext substitution before writing", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  const original = f.state.bytes;
  f.state.bytes = independentSeal(initialStore(2), f.config.objectUrl);
  await f.backend.listItems(session);
  f.state.bytes = original;
  await expect(f.backend.listItems(session)).rejects.toBeInstanceOf(
    EncryptedRemoteConflictError,
  );
  f.state.bytes = independentSeal(initialStore(2), f.config.objectUrl);
  await expect(f.backend.deleteItem?.(ITEM_ID, session)).rejects.toBeInstanceOf(
    EncryptedRemoteConflictError,
  );
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
});
it("actual owner lock and same-tomb unlock rejects the held response and all later old-session requests", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  f.state.hold = true;
  const rejected = expect(f.backend.listItems(session)).rejects.toThrow();
  operations.push(rejected);
  await f.entered.promise;
  vaultStore.lock();
  await vaultStore.unlock(runtimePassword);
  f.release.resolve();
  await rejected;
  expect(session.signal?.aborted).toBe(true);
  const requests = f.requests.length;
  await expect(f.backend.getItem(ITEM_ID, session)).rejects.toThrow();
  expect(f.requests).toHaveLength(requests);
});
it("disconnect cancels an actual partial response body and leaves no usable session", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  f.state.holdBody = true;
  const rejected = expect(f.backend.listItems(session)).rejects.toThrow();
  operations.push(rejected);
  await f.entered.promise;
  await f.backend.disconnect(session);
  f.release.resolve();
  await rejected;
  expect(session.signal?.aborted).toBe(true);
  const requests = f.requests.length;
  await expect(f.backend.listItems(session)).rejects.toThrow();
  expect(f.requests).toHaveLength(requests);
});
it("target authority withdrawal prevents old sessions from sending credentials to any new endpoint", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  f.rotateTarget();
  const count = f.requests.length;
  await expect(
    f.backend.createItem?.({ name: "Blocked", notes: "", secret: "" }, session),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});
it("actual unauthorized reads terminate the session before another provider request", async () => {
  const f = await setup();
  const session = await f.backend.authenticate(f.config);
  f.state.unauthorized = true;
  await expect(f.backend.listItems(session)).rejects.toMatchObject({
    code: "authentication",
  });
  expect(session.signal?.aborted).toBe(true);
  const count = f.requests.length;
  await expect(f.backend.listItems(session)).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});
it("redirects and oversized streamed ciphertext never become a successful connection or mutation", async () => {
  const f = await setup();
  f.state.redirect = true;
  await expect(f.backend.authenticate(f.config)).rejects.toThrow();
  expect(f.requests.map((row) => row.path)).toEqual(["/objects/vault.json"]);
  f.state.redirect = false;
  f.state.bytes = "a".repeat(4 * 1024 * 1024 + 1);
  await expect(f.backend.authenticate(f.config)).rejects.toThrow("exceeds");
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
});
it("invalid configuration and unknown deletion cannot write or disclose the key", async () => {
  const f = await setup();
  for (const changes of [
    { objectUrl: "http://example.test/store" },
    { encryptionKey: "bad" },
    { bearerToken: ENCRYPTION_KEY },
  ])
    await expect(
      f.backend.authenticate({ ...f.config, ...changes }),
    ).rejects.toThrow();
  expect(f.requests).toEqual([]);
  const session = await f.backend.authenticate(f.config);
  await expect(
    f.backend.deleteItem?.("33333333-1234-4234-9234-123456789abc", session),
  ).rejects.toMatchObject({ code: "not-found" });
  await expect(
    f.backend.createItem?.(
      { name: "Independent fixture note", notes: "bad duplicate", secret: "" },
      session,
    ),
  ).rejects.toThrow();
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
});
it("WebCrypto output opens under independent Node AEAD and genuine Node output opens with exact target-bound AAD", async () => {
  const identity = {
    objectUrl: "https://object.example/vault.json",
    storeId: initialStore().storeId,
  };
  const key = await remoteEncryptionKey(ENCRYPTION_KEY);
  expect(key.extractable).toBe(false);
  const node = independentSeal(initialStore(), identity.objectUrl);
  expect(await openRemoteStore(node, identity, key)).toEqual(initialStore());
  const web = await sealRemoteStore(initialStore(), identity, key);
  expect(independentOpen(web, identity.objectUrl)).toEqual(initialStore());
  expect(node).not.toBe(web);
  await expect(
    openRemoteStore(
      node,
      { ...identity, objectUrl: "https://other.example/vault.json" },
      key,
    ),
  ).rejects.toThrow();
  const envelope = JSON.parse(node);
  for (const changed of [
    { revision: 2 },
    { nonce: "AAAAAAAAAAAAAAAA" },
    { storeId: ITEM_ID },
    { ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` },
  ])
    await expect(
      openRemoteStore(
        JSON.stringify({ ...envelope, ...changed }),
        identity,
        key,
      ),
    ).rejects.toThrow();
});
it("duplicate identities, unknown ciphertext envelope fields and malformed canonical base64 are rejected", async () => {
  expect(() =>
    remoteStore({
      ...initialStore(),
      items: [...initialStore().items, ...initialStore().items],
    }),
  ).toThrow();
  const identity = {
    objectUrl: "https://object.example/vault.json",
    storeId: initialStore().storeId,
  };
  const key = await remoteEncryptionKey(ENCRYPTION_KEY);
  const envelope = JSON.parse(
    independentSeal(initialStore(), identity.objectUrl),
  );
  envelope.extra = "unbound";
  await expect(
    openRemoteStore(JSON.stringify(envelope), identity, key),
  ).rejects.toThrow();
  await expect(
    remoteEncryptionKey(`${ENCRYPTION_KEY.slice(0, -1)} `),
  ).rejects.toThrow();
});
it("backs up through the common port and cold-restores into a different PIN vault without adopting its identity", async () => {
  const f = await setup();
  const sourcePin = "73918426";
  await vaultStore.enrollPin(sourcePin);
  await vaultStore.removePassword();
  const source = createItem("secret", "Backup source secret");
  source.value = "encrypted-object-backup-plaintext";
  await vaultStore.saveItem(source);
  const sourceIdentity = readVaultFile(vaultStore.exportSealed()).header.unlocks
    ?.pin;
  const session = await f.backend.authenticate(f.config);
  const backup = await backUpVaultToSecretBackend(
    { backend: f.backend, session },
    "Remote encrypted backup",
  );
  expect(
    f.requests
      .filter((row) => row.method === "PUT")
      .every(
        (row) =>
          !row.body.includes(source.value) && !row.body.includes(sourcePin),
      ),
  ).toBe(true);
  await f.backend.disconnect(session);
  const targetPin = "84261973";
  await freshLocalVault(f.files, targetPin);
  const targetIdentity = readVaultFile(vaultStore.exportSealed()).header.unlocks
    ?.pin;
  expect(targetIdentity).toBeTruthy();
  expect(targetIdentity).not.toEqual(sourceIdentity);
  const backend = createEncryptedRemoteBackend(f.capture().transport);
  const cold = { backend, session: await backend.authenticate(f.config) };
  await expect(
    restoreVaultFromSecretBackend(cold, backup.id, targetPin),
  ).rejects.toThrow();
  expect(await restoreVaultFromSecretBackend(cold, backup.id, sourcePin)).toBe(
    1,
  );
  await backend.disconnect(cold.session);
  vaultStore.lock();
  await expect(vaultStore.unlockWithPin(sourcePin)).rejects.toThrow();
  await vaultStore.unlockWithPin(targetPin);
  expect(vaultStore.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: source.id, value: source.value }),
  );
  expect(readVaultFile(vaultStore.exportSealed()).header.unlocks?.pin).toEqual(
    targetIdentity,
  );
});
