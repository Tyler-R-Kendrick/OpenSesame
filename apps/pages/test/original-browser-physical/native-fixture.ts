/** Native browser fixture only: OPFS/IDB/Web Locks remain original. No REAL permit is issued. */
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { kvFileName } from "@opensesame/app-core/lib/kv.js";
import { AT_REST_DATABASE } from "@opensesame/app-core/lib/storage-ownership.js";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
type NativeFixtureOverrides = {
  env: { BASE_URL: string; DEV: boolean };
  originFiles?: () => Promise<FileSystemDirectoryHandle>;
};
export const DEVICE = "tomb/personal/retired-credentials.v2";
export const CANARY = `opensesame-private/agent-canaries/${"a".repeat(64)}.v1`;
const checks: string[] = [];
export function check(value: boolean, label: string): void {
  if (!value) throw new Error(`Native browser control failed: ${label}`);
  checks.push(label);
}
export function result() {
  return { checks: [...checks] };
}
export function reset() {
  checks.length = 0;
}
export function install(provider?: () => Promise<FileSystemDirectoryHandle>) {
  const overrides: NativeFixtureOverrides = {
    env: { BASE_URL: "/", DEV: false },
  };
  if (provider) overrides.originFiles = provider;
  const original = composeHost(browserPorts(), overrides);
  configureHost(original);
  return original;
}
export async function ready(
  provider?: () => Promise<FileSystemDirectoryHandle>,
) {
  const original = install(provider);
  const key = await atRestReady();
  check(key.durable, "actual durable device key");
  check(original.locks === navigator.locks, "native Web Locks");
  await inspectKey();
  return original;
}
export async function refuses<T>(work: () => Promise<T>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Native refusal was not an Error.");
  }
  throw new Error("Native control unexpectedly accepted an operation.");
}
export async function raw(key: string): Promise<string> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(kvFileName(key));
  return (await file.getFile()).text();
}
export async function writeRaw(key: string, value: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(kvFileName(key), { create: true });
  const stream = await file.createWritable();
  try {
    await stream.write(value);
    await stream.close();
  } catch (error) {
    await stream.abort(error);
    throw error;
  }
}
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Native IDB request failed."));
  });
}
export async function inspectKey() {
  const db = await request(indexedDB.open(AT_REST_DATABASE, 1));
  try {
    const value: BoundaryValue = await request(
      db.transaction("keys", "readonly").objectStore("keys").get("device"),
    );
    if (!isJsonObject(value))
      throw new Error("Native device key record is missing.");
    const wrapping = value.wrappingKey;
    if (!(wrapping instanceof CryptoKey))
      throw new Error("Native wrapping key is absent.");
    check(!wrapping.extractable, "actual nonextractable IDB wrapping key");
    await refuses(() => crypto.subtle.exportKey("raw", wrapping));
    check(true, "native wrapping key export is refused");
  } finally {
    db.close();
  }
}
export async function deleteKey() {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(AT_REST_DATABASE);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(req.error ?? new Error("Native IDB deletion failed."));
    req.onblocked = () => reject(new Error("Native IDB deletion blocked."));
  });
}
export async function keyAbsent() {
  const databases = await indexedDB.databases();
  if (!databases.some((db) => db.name === AT_REST_DATABASE)) return true;
  const db = await request(indexedDB.open(AT_REST_DATABASE, 1));
  try {
    return (
      (await request(
        db.transaction("keys", "readonly").objectStore("keys").get("device"),
      )) === undefined
    );
  } finally {
    db.close();
  }
}
