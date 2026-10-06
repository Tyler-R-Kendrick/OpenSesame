import { openEncryptedDb } from "../../packages/app-core/src/lib/encrypted-db/db.ts";
import { deriveEdbKeys } from "../../packages/app-core/src/lib/encrypted-db/keys.ts";
import { openSealed } from "../../packages/app-core/src/lib/encrypted-db/rows.ts";
import { defineSchema } from "../../packages/app-core/src/lib/encrypted-db/schema.ts";

const schema = defineSchema({
  rows: { key: "id", columns: { owner: { eq: true } } },
});
const logical = "customer-browser-index";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
async function rawDatabase(name) {
  return request(indexedDB.open(name));
}
async function records(db) {
  const store = db.transaction("r").objectStore("r");
  const values = await request(store.getAll());
  const keys = await request(store.getAllKeys());
  return values.map((value, index) => ({ value, key: keys[index] }));
}
async function copyRecords(source, target) {
  const copied = await records(source);
  const tx = target.transaction("r", "readwrite");
  for (const row of copied) tx.objectStore("r").put(row.value, row.key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return copied;
}
async function writeRecord(db, key, value) {
  const tx = db.transaction("r", "readwrite");
  tx.objectStore("r").put(value, key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function verifyTargetSlot(aRow, bRow, raw, b) {
  await writeRecord(raw, bRow.key, aRow.value);
  check(
    (await b.get("rows", "same-id")) === undefined,
    "ciphertext transplanted to target row slot rejected",
  );
  await writeRecord(raw, bRow.key, { c: bRow.value.c, x: aRow.value.x });
  check(
    (await b.find("rows", { owner: "same-owner" })).length === 0,
    "foreign index tokens cannot find same-value target row",
  );
  await writeRecord(raw, bRow.key, bRow.value);
}
async function verifyTransplants(a, b) {
  const source = await rawDatabase(a.name);
  const target = await rawDatabase(b.name);
  const root = await globalThis.recordKeys.indexedDbAtRestKeys.load();
  const keysA = deriveEdbKeys(root, logical, "A");
  const keysB = deriveEdbKeys(root, logical, "B");
  try {
    const before = await records(target);
    const copied = await copyRecords(source, target);
    check(
      copied.every((row) => before.every((other) => row.key !== other.key)),
      "customer pseudonyms differ",
    );
    const rowA = copied.find((row) => row.key !== keysA.metaId);
    const rowB = before.find((row) => row.key !== keysB.metaId);
    check(rowA.value.c !== rowB.value.c, "customer ciphertext differs");
    check(
      rowA.value.x.every((token) => !rowB.value.x.includes(token)),
      "customer index tokens differ",
    );
    await verifyTargetSlot(rowA, rowB, target, b);
    const meta = copied.find((row) => row.key === keysA.metaId);
    check(
      openSealed(keysB, keysB.metaId, meta.value.c) === null,
      "metadata transplant rejected at target slot",
    );
    check(
      openSealed(keysB, keysA.metaId, meta.value.c) === null,
      "metadata transplant rejected at source slot",
    );
    check(
      (await b.find("rows", { owner: "same-owner" })).length === 1,
      "foreign index entries do not add cross-customer matches",
    );
    check(
      (await b.all("rows")).length === 1,
      "transplanted ciphertext does not decrypt",
    );
  } finally {
    keysA.wipe();
    keysB.wipe();
    root.fill(0);
    source.close();
    target.close();
  }
}
export async function verifyCustomerEncryptedDb(mode) {
  const a = await openEncryptedDb(logical, schema, "A");
  const b = await openEncryptedDb(logical, schema, "B");
  try {
    check(a.name !== b.name, "customer database names differ");
    if (mode === "write") {
      await a.put("rows", {
        id: "same-id",
        owner: "same-owner",
        secret: "A bearer",
      });
      await b.put("rows", {
        id: "same-id",
        owner: "same-owner",
        secret: "B bearer",
      });
      await a.find("rows", { owner: "same-owner" });
      await b.find("rows", { owner: "same-owner" });
      await verifyTransplants(a, b);
    }
    check(
      (await a.get("rows", "same-id")).secret === "A bearer",
      "customer A persisted row opens",
    );
    check(
      (await b.get("rows", "same-id")).secret === "B bearer",
      "customer B persisted row opens",
    );
    check(
      (await b.find("rows", { owner: "same-owner" })).length === 1,
      "customer index separation persists",
    );
    return [
      mode === "write"
        ? "actual IndexedDB encrypted-search isolates equal IDs, row/meta/index transplants across customers"
        : "actual IndexedDB encrypted-search customer keys and rows survive browser reload",
    ];
  } finally {
    a.close();
    b.close();
  }
}
