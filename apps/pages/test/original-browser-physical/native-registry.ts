/** Native physical inventory completeness controls; registry edits retain actual sealed files. */
import type { Host } from "@opensesame/app-core/host.js";
import {
  kvFileName,
  kvFlush,
  kvGet,
  kvSetDurable,
} from "@opensesame/app-core/lib/kv.js";
import { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { check, ready, refuses, result } from "./native-fixture.js";
const REGISTRY = "tombs.v1";
const HEADER = "tomb/personal/header";
const BODY = "tomb/personal/body";
async function catalogue(original: Host) {
  const port = original.physicalCurrentCredentialCatalogue;
  if (!port) throw new Error("Native catalogue producer absent.");
  const reader = await port.capture(() => {});
  try {
    return await reader.read();
  } finally {
    await reader.close();
  }
}
async function inventory(original: Host) {
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native device producer absent.");
  const reader = await port.capture(() => {});
  try {
    if (!reader.captureRetiredCredentialInventory)
      throw new Error("Native retirement inventory absent.");
    return await reader.captureRetiredCredentialInventory();
  } finally {
    await reader.close();
  }
}
async function rejectsIncomplete(original: Host, label: string) {
  await refuses(() => catalogue(original));
  check(
    true,
    `${label}: current credential catalogue refuses incomplete registry`,
  );
  await refuses(() => inventory(original));
  check(true, `${label}: retirement inventory refuses incomplete registry`);
  return result();
}
async function sealedVault() {
  const original = await ready();
  const store = new VaultStore();
  try {
    await store.create("controlled original registry owner password");
    await kvFlush();
  } finally {
    store.lock();
  }
  return original;
}
export async function deletedRegistry() {
  const original = await sealedVault();
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(kvFileName(REGISTRY));
  return rejectsIncomplete(original, "deleted registry retains sealed vault");
}
export async function restoredRegistry() {
  const original = await sealedVault();
  const older = kvGet(REGISTRY);
  const header = kvGet(HEADER);
  const body = kvGet(BODY);
  if (older === null || header === null || body === null)
    throw new Error("Original sealed registry fixture absent.");
  await kvSetDurable("tomb/foreign/header", header);
  await kvSetDurable("tomb/foreign/body", body);
  await kvSetDurable(
    REGISTRY,
    JSON.stringify({ v: 1, tombs: ["personal", "foreign"] }),
  );
  check(
    (await catalogue(original)).scopes.length === 2,
    "complete two-vault registry is accepted",
  );
  await kvSetDurable(REGISTRY, older);
  return rejectsIncomplete(
    original,
    "restored older registry omits second vault",
  );
}
export async function orphanRecord(kind: string) {
  if (kind !== "header" && kind !== "body" && kind !== "retired-credentials.v2")
    throw new Error("Unknown original orphan fixture.");
  const original = await ready();
  await kvSetDurable(
    `tomb/foreign/${kind}`,
    "controlled original sealed orphan",
  );
  return rejectsIncomplete(original, `unregistered ${kind}`);
}
export async function emptyProfile() {
  const original = await ready();
  check(
    (await catalogue(original)).scopes.length === 0,
    "genuinely empty profile has no current credential scopes",
  );
  check(
    (await inventory(original)).length === 0,
    "genuinely empty profile has no retired records",
  );
  return result();
}

export async function catalogueAfterCaptureDrift() {
  const original = await ready();
  const port = original.physicalCurrentCredentialCatalogue;
  if (!port) throw new Error("Native catalogue producer absent.");
  const reader = await port.capture(() => {});
  try {
    check(
      (await reader.read()).scopes.length === 0,
      "captured genuinely empty catalogue is accepted",
    );
    await kvSetDurable(
      "tomb/foreign/header",
      "controlled original sealed later header",
    );
    await refuses(() => reader.read());
    check(
      true,
      "captured catalogue refuses subsequently unregistered physical header",
    );
  } finally {
    await reader.close();
  }
  return result();
}
