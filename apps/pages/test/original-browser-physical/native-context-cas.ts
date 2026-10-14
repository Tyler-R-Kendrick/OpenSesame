/** Native handle/context/CAS controls. Provider changes still deliver real OPFS handles. */
import { host } from "@opensesame/app-core/host.js";
import { kvSetDurable } from "@opensesame/app-core/lib/kv.js";
import { CREDENTIAL_LOCK_NAME } from "@opensesame/app-core/lib/retired-credentials/credential-lock.js";
import type { PhysicalDeviceRecordReader } from "@opensesame/app-core/lib/vault/physical-device-record-port.js";
import { withBodyWriteLock } from "@opensesame/app-core/lib/vault/vault-shared-locks.js";
import {
  DEVICE,
  check,
  raw,
  ready,
  refuses,
  result,
} from "./native-fixture.js";
export async function providerReplacement() {
  const original = await ready();
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native device producer is absent.");
  const reader = await port.capture(() => {});
  const descriptor = Object.getOwnPropertyDescriptor(original, "originFiles");
  const native = await navigator.storage.getDirectory();
  if (!descriptor) throw new Error("Original provider descriptor absent.");
  try {
    Object.defineProperty(original, "originFiles", {
      configurable: true,
      enumerable: true,
      value: () => Promise.resolve(native),
    });
    await refuses(() => reader.revalidateRoot());
    check(true, "changed provider slot refuses even the same native directory");
  } finally {
    Object.defineProperty(original, "originFiles", descriptor);
    await reader.close();
  }
  const fresh = await port.capture(() => {});
  await fresh.revalidateRoot();
  await fresh.close();
  check(true, "restored original provider still works");
  return result();
}
export async function rootReplacement() {
  const native = await navigator.storage.getDirectory();
  const other = await native.getDirectoryHandle("controlled-other-root", {
    create: true,
  });
  let selected = native;
  const original = await ready(() => Promise.resolve(selected));
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native device producer is absent.");
  const reader = await port.capture(() => {});
  selected = other;
  const cause = await refuses(() => reader.revalidateRoot());
  const closing = await refuses(() => reader.close());
  check(
    closing instanceof AggregateError && closing.errors.includes(cause),
    "native distinct root identity refuses and retains actual cause",
  );
  selected = native;
  const fresh = await port.capture(() => {});
  await fresh.revalidateRoot();
  await fresh.close();
  check(
    true,
    "same original native directory recovers without rebinding old capture",
  );
  return result();
}
export async function catalogueDrift() {
  const original = await ready();
  await kvSetDurable("tombs.v1", JSON.stringify({ v: 1, tombs: ["personal"] }));
  const port = original.physicalCurrentCredentialCatalogue;
  if (!port) throw new Error("Native catalogue producer absent.");
  const reader = await port.capture(() => {});
  const snapshot = await reader.read();
  await kvSetDurable(
    "tombs.v1",
    JSON.stringify({ v: 1, tombs: ["personal", "foreign"] }),
  );
  await refuses(() => reader.revalidate(snapshot));
  await reader.close();
  const fresh = await port.capture(() => {});
  try {
    const listing = await fresh.read();
    check(
      listing.scopes.map((row) => row.tomb).join(",") === "foreign,personal",
      "fresh catalogue sees real changed native registry",
    );
    const row = listing.scopes.find((scope) => scope.tomb === "foreign");
    if (!row) throw new Error("Native foreign row absent.");
    const scope = await fresh.captureScope(row, () => {});
    try {
      await refuses(() => scope.read());
    } finally {
      await scope.close();
    }
    check(
      true,
      "listed foreign tomb without actual HEADER/BODY cannot certify a scope",
    );
  } finally {
    await fresh.close();
  }
  return result();
}
let casReader: PhysicalDeviceRecordReader | undefined;
let casValue: string | undefined;
export async function prepareCas(label: string) {
  const original = await ready();
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native device producer absent.");
  casReader = await port.capture(() => {});
  check(
    (await casReader.read(DEVICE, 32768)) === null,
    "both publishers capture absent original record",
  );
  casValue = JSON.stringify({ fixture: label });
  return result();
}
export async function commitCas() {
  const reader = casReader;
  const value = casValue;
  if (!reader || !value) throw new Error("Native CAS was not prepared.");
  const locks = host().locks;
  if (locks !== navigator.locks)
    throw new Error("Original native locks unavailable.");
  let failure: Error | undefined;
  try {
    await locks.request(CREDENTIAL_LOCK_NAME, { mode: "exclusive" }, () =>
      withBodyWriteLock("personal", () =>
        reader.publish(DEVICE, null, value, 32768),
      ),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Storage record changed."
    )
      throw error;
    failure = error;
  }
  if (failure) {
    const closed = await refuses(() => reader.close());
    check(
      closed instanceof AggregateError && closed.errors.includes(failure),
      "CAS loser retains its real conflict cause",
    );
  } else {
    await reader.close();
  }
  casReader = undefined;
  return { committed: !failure };
}
export async function readCas() {
  const port = host().physicalDeviceRecords;
  if (!port) throw new Error("Native device producer absent.");
  const reader = await port.capture(() => {});
  try {
    const value = await reader.read(DEVICE, 32768);
    check(
      value === JSON.stringify({ fixture: "A" }) ||
        value === JSON.stringify({ fixture: "B" }),
      "one actual CAS winner persists",
    );
    check(
      (await raw(DEVICE)).startsWith("osr2."),
      "CAS winner is actually device sealed",
    );
    return { value, ...result() };
  } finally {
    await reader.close();
  }
}
