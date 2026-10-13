/** Actual original browser producers: DATA controls do not certify modern factor admission. */
import { type Host, host } from "@opensesame/app-core/host.js";
import {
  atRestReady,
  atRestSettled,
  forgetAtRestKeyForTest,
} from "@opensesame/app-core/lib/at-rest/key.js";
import {
  kvDurability,
  kvFlush,
  kvForgetAll,
  kvGet,
  kvHydrate,
  kvSetDurable,
} from "@opensesame/app-core/lib/kv.js";
import type { PhysicalCurrentCredentialScopeReader } from "@opensesame/app-core/lib/vault/physical-current-credential-catalogue.js";
import { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import * as fixture from "./native-fixture.js";
const PASSWORD = "controlled original browser owner password";
const HEADER = "tomb/personal/header";
const BODY = "tomb/personal/body";
export async function roundtrip() {
  const original = await fixture.ready();
  const store = new VaultStore();
  try {
    await store.create(PASSWORD);
    const item = createItem("note", "native physical fixture");
    item.notes = "actual AEAD BODY payload survives native storage";
    await store.saveItem(item);
    await kvFlush();
    fixture.check(
      kvDurability() === "persistent",
      "OPFS persistence, no memory fallback",
    );
    const header = kvGet(HEADER);
    const body = kvGet(BODY);
    if (header === null || body === null)
      throw new Error("Original vault ciphertext is missing.");
    await inspectOriginalCiphertext(original, header, body, item.notes);
    store.lock();
    await kvHydrate([HEADER, BODY, "tomb/personal/index", "tombs.v1"]);
    const reopened = new VaultStore();
    try {
      await reopened.unlock(PASSWORD);
      fixture.check(
        reopened
          .getSnapshot()
          .items.some(
            (entry) => entry.id === item.id && entry.notes === item.notes,
          ),
        "real password unwrap and AEAD reopen",
      );
    } finally {
      reopened.lock();
    }
  } finally {
    store.lock();
    await kvFlush();
  }
  return fixture.result();
}
export async function noInitialization() {
  const original = fixture.install();
  fixture.check(
    atRestSettled() === null,
    "device key not initialized before capture",
  );
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native OPFS producer is absent.");
  await fixture.refuses(() => port.capture(() => {}));
  fixture.check(
    atRestSettled() === null && (await fixture.keyAbsent()),
    "capture cannot mint a missing key",
  );
  await fixture.ready();
  const fresh = host().physicalDeviceRecords;
  if (!fresh) throw new Error("Fresh native producer is absent.");
  const captured = await fresh.capture(() => {});
  await captured.close();
  fixture.check(true, "normal explicit key bootstrap permits fresh capture");
  return fixture.result();
}
export async function seedKeyLoss() {
  await fixture.ready();
  await kvSetDurable(
    fixture.DEVICE,
    "controlled device record retained after key loss",
  );
  await kvFlush();
  const before = await fixture.raw(fixture.DEVICE);
  await fixture.deleteKey();
  fixture.check(
    await fixture.keyAbsent(),
    "native key record physically deleted",
  );
  return { before };
}
export async function missingKey(before: string) {
  const original = fixture.install();
  const key = await atRestReady();
  fixture.check(
    !key.durable,
    "seals without native key refuse new durable initialization",
  );
  fixture.check(
    await fixture.keyAbsent(),
    "no replacement device key record minted",
  );
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native producer is absent.");
  await fixture.refuses(() => port.capture(() => {}));
  fixture.check(
    (await fixture.raw(fixture.DEVICE)) === before,
    "original sealed bytes survive key loss",
  );
  return fixture.result();
}
export async function keyReplacement() {
  const original = await fixture.ready();
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native producer is absent.");
  const reader = await port.capture(() => {});
  await fixture.deleteKey();
  forgetAtRestKeyForTest();
  fixture.check(
    (await atRestReady()).durable,
    "actual native key re-created only on empty origin",
  );
  await fixture.refuses(() => reader.revalidateRoot());
  await reader.close();
  fixture.check(
    true,
    "prior capture refuses actual device-key generation replacement",
  );
  return fixture.result();
}
export async function allCausesAndBound() {
  const original = await fixture.ready();
  await kvSetDurable(fixture.DEVICE, "a bounded actual device plaintext");
  await kvSetDurable(fixture.CANARY, "an actual separate device plaintext");
  await kvFlush();
  const port = original.physicalDeviceRecords;
  if (!port) throw new Error("Native producer is absent.");
  const reader = await port.capture(() => {});
  await fixture.writeRaw(fixture.CANARY, "osr2.AA");
  const outcomes = await Promise.allSettled([
    reader.read(fixture.DEVICE, 1),
    reader.read(fixture.CANARY, 32768),
  ]);
  const failures: BoundaryValue[] = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  fixture.check(
    failures.length === 2,
    "both actual bound and malformed ciphertext reads fail",
  );
  const closing = reader.close();
  fixture.check(
    closing === reader.close(),
    "close preserves original Promise identity",
  );
  const cause = await fixture.refuses(() => closing);
  fixture.check(
    cause instanceof AggregateError &&
      cause.errors.length === 2 &&
      failures.every((failure) => cause.errors.includes(failure)),
    "close retains all actual accepted-work causes",
  );
  await fixture.refuses(() => reader.read(fixture.DEVICE, 32768));
  const bounded = await port.capture(() => {});
  const identity = bounded.readOriginalStateIdentity;
  if (!identity) throw new Error("Original identity reader absent.");
  await Promise.all(Array.from({ length: 512 }, () => identity()));
  await fixture.refuses(async () => identity());
  await bounded.close();
  fixture.check(
    true,
    "512 genuine native accepted operations then busy refusal",
  );
  return fixture.result();
}

async function inspectOriginalCiphertext(
  original: Host,
  header: string,
  body: string,
  note: string,
) {
  const authPort = original.physicalVaultAuthentication;
  const devicePort = original.physicalDeviceRecords;
  const cataloguePort = original.physicalCurrentCredentialCatalogue;
  if (!authPort || !devicePort || !cataloguePort)
    throw new Error("Actual producers are absent.");
  const first = await authPort.capture("personal", () => {});
  const second = await devicePort.capture(() => {});
  const catalogue = await cataloguePort.capture(() => {});
  let scopeReader: PhysicalCurrentCredentialScopeReader | undefined;
  try {
    const snapshot = await first.read();
    fixture.check(
      snapshot.header === header && snapshot.body === body,
      "actual HEADER/BODY physical roundtrip",
    );
    const identity = first.readOriginalStateIdentity;
    const deviceIdentity = second.readOriginalStateIdentity;
    if (!identity || !deviceIdentity)
      throw new Error("Original root identity is absent.");
    const listing = await catalogue.read();
    fixture.check(
      (await identity()) === (await deviceIdentity()) &&
        (await identity()) === listing.physicalIdentity,
      "two captures and catalogue share original root identity",
    );
    const row = listing.scopes.find((scope) => scope.tomb === "personal");
    if (!row) throw new Error("Actual personal catalogue row is missing.");
    await fixture.refuses(() => catalogue.captureScope({ ...row }, () => {}));
    fixture.check(true, "copied catalogue row is refused");
    scopeReader = await catalogue.captureScope(row, () => {});
    const selected = await scopeReader.read();
    fixture.check(
      selected.kind === "legacy" &&
        selected.header === header &&
        selected.body === body,
      "original issued catalogue row reads original ciphertext",
    );
    await scopeReader.revalidate(selected);
    fixture.check(
      (await fixture.raw(HEADER)).startsWith("osr2.") &&
        !(await fixture.raw(BODY)).includes(note),
      "native files contain device ciphertext",
    );
    kvForgetAll();
    fixture.check(
      (await first.read()).body === body,
      "physical producer ignores missing memory copy",
    );
  } finally {
    if (scopeReader) await scopeReader.close();
    await catalogue.close();
    await second.close();
    await first.close();
  }
}
