/** Actual original browser producers: DATA controls do not certify modern factor admission. */
import type { Host } from "@opensesame/app-core/host.js";
import {
  kvDurability,
  kvFlush,
  kvForgetAll,
  kvGet,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import type { PhysicalCurrentCredentialScopeReader } from "@opensesame/app-core/lib/vault/physical-current-credential-catalogue.js";
import { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
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
