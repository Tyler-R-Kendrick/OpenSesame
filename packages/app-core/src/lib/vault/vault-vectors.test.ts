/**
 * Golden vault vectors must open unchanged (ADR 0133 §7). The fixture was
 * emitted by `apps/pages/scripts/emit-vault-vectors.mjs` before the shared-core move; a
 * failure here is a format break, never a reason to regenerate it.
 */
import { overlapCast } from "@opensesame/os-domain";
import {
  DEVICE_IDENTITY_KEY_PATH,
  type SealedVaultFile,
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  b64ToBytes,
  openVaultBody,
  readDeviceIdentityKeyRecord,
  readVaultFile,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../../spec/conformance/vault-vectors.json" with {
  type: "json",
};
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import { ensureDeviceIdentityKey } from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { sealedVaultText } from "./offline-backup-file.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import { VaultStore } from "./store.js";
import {
  listPasskeyUnlockRecords,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
} from "./unlock-methods.js";

type Expectation = {
  tomb: string;
  bound: boolean;
  rev: number | null;
  items: { id: string; name: string; kind: string }[];
  /** Files the body carries that are listed by name only (ADR 0160 §5). */
  concealed?: string[];
};
type Opened = SealedVaultFile;

/** Envelope → header, sealed body and the tomb its binding names (format §7). */
const openEnvelope = readVaultFile;
const openBody = (raw: Uint8Array, opened: Opened) =>
  openVaultBody(opened, raw);

function summarize(body: VaultBody, bound: boolean, tomb: string): Expectation {
  return {
    tomb,
    bound,
    rev: body.rev ?? null,
    items: body.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
    })),
    ...(body.deviceIdentityKey !== undefined
      ? { concealed: [DEVICE_IDENTITY_KEY_PATH] }
      : undefined),
  };
}

const vectors = Object.entries(fixture.vectors);

/**
 * The vectors record what was written. A `login` item (ADR 0172 §1) is read
 * and normalized to an account, so every other part of an expectation holds
 * and the kind it names comes out as `account`.
 */
function normalized(expectation: Expectation): Expectation {
  return {
    ...expectation,
    items: expectation.items.map((item) => ({
      ...item,
      kind: item.kind === "login" ? "account" : item.kind,
    })),
  };
}

describe("golden vault vectors", () => {
  it.each(vectors)("%s opens with the password", async (_name, vector) => {
    const opened = openEnvelope(vector.file);
    const raw = await unwrapRawVaultKeyFromPassword(
      opened.header,
      fixture.password,
    );
    const { body, bound } = await openBody(raw, opened);
    expect(summarize(body, bound, opened.tomb)).toEqual(
      normalized(vector.expect),
    );
  });

  it("opens every legacy login vector as accounts, none left as login", async () => {
    const legacy = vectors.filter(([, vector]) =>
      vector.expect.items.some((item) => item.kind === "login"),
    );
    expect(legacy.length).toBeGreaterThan(0);
    for (const [name, vector] of legacy) {
      const opened = openEnvelope(vector.file);
      const raw = await unwrapRawVaultKeyFromPassword(
        opened.header,
        fixture.password,
      );
      const { body } = await openBody(raw, opened);
      const kinds = body.items.map((item) => item.kind);
      expect(kinds, name).toContain("account");
      expect(kinds, name).not.toContain("login");
      expect(JSON.stringify(body), name).not.toContain('"kind":"login"');
    }
  });

  it("normalizes the password with NFKC before deriving", async () => {
    expect(fixture.passwordNfkc).not.toBe(fixture.password);
    const opened = openEnvelope(fixture.vectors["export-personal"].file);
    const raw = await unwrapRawVaultKeyFromPassword(
      opened.header,
      fixture.passwordNfkc,
    );
    expect(raw).toHaveLength(32);
  });

  it("refuses a wrong password as WrongPasswordError", async () => {
    const opened = openEnvelope(fixture.vectors["backup-personal"].file);
    await expect(
      unwrapRawVaultKeyFromPassword(opened.header, "not the vector password"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("refuses a body bound to another tomb", async () => {
    const opened = openEnvelope(fixture.vectors["backup-project"].file);
    const raw = await unwrapRawVaultKeyFromPassword(
      opened.header,
      fixture.password,
    );
    await expect(
      openBody(raw, { ...opened, tomb: "personal" }),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it.each([
    ["weakened iterations", { iterations: 599_999 }],
    ["truncated salt", { saltB64: "AAAA" }],
    ["unknown algorithm", { alg: "PBKDF2-SHA1" }],
  ])("refuses a header with %s before deriving", async (_name, patch) => {
    const opened = openEnvelope(fixture.vectors["export-personal"].file);
    const kdf: VaultHeader["kdf"] = overlapCast({
      ...opened.header.kdf,
      ...patch,
    });
    await expect(
      unwrapRawVaultKeyFromPassword(
        { ...opened.header, kdf },
        fixture.password,
      ),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("opens the project body through its PIN wrap", async () => {
    const vector = fixture.vectors["backup-project"];
    const opened = openEnvelope(vector.file);
    const pin = opened.header.unlocks?.pin;
    if (!pin) throw new Error("vector has no PIN wrap");
    const raw = await unwrapVaultKeyWithPin(pin, fixture.pin);
    const { body, bound } = await openBody(raw, opened);
    expect(summarize(body, bound, opened.tomb)).toEqual(
      normalized(vector.expect),
    );
  });

  it("opens the project body through its passkey PRF wrap", async () => {
    const vector = fixture.vectors["backup-project"];
    const opened = openEnvelope(vector.file);
    const [record] = listPasskeyUnlockRecords(opened.header.unlocks);
    if (!record) throw new Error("vector has no passkey wrap");
    const prf = b64ToBytes(fixture.prfOutputB64);
    const raw = await unwrapVaultKeyWithPrf(record, prf.slice().buffer);
    const { body, bound } = await openBody(raw, opened);
    expect(summarize(body, bound, opened.tomb)).toEqual(
      normalized(vector.expect),
    );
  });

  it("imports the personal export through the real store", async () => {
    const store = new VaultStore();
    await store.create("an unrelated master passphrase 2026");
    const merged = await store.importSealed(
      fixture.vectors["export-personal"].file,
      fixture.password,
    );
    expect(merged).toBe(2);
    const names = store.getSnapshot().items.map((item) => item.name);
    expect(names).toEqual(["Personal login", "Personal note"]);
    // The imported login is an account in memory, and what the store seals
    // from here never says `login`.
    expect(store.getSnapshot().items.map((item) => item.kind)).toEqual([
      "account",
      "note",
    ]);
    await store.flushPendingWrites();
    const sealed = JSON.parse(store.exportSealed());
    const opened = await openBody(
      await unwrapRawVaultKeyFromPassword(
        sealed.header,
        "an unrelated master passphrase 2026",
      ),
      {
        format: "opensesame-vault-export",
        tomb: sealed.tomb,
        header: sealed.header,
        body: sealed.body,
      },
    );
    expect(JSON.stringify(opened.body)).not.toContain('"kind":"login"');
    store.lock();
  });

  it("restores the identity vector's principal through the real store (ADR 0160 §5)", async () => {
    const vector = fixture.vectors["backup-device-identity"];
    const opened = openEnvelope(vector.file);
    const raw = await unwrapRawVaultKeyFromPassword(
      opened.header,
      fixture.password,
    );
    const { body } = await openBody(raw, opened);
    const recorded = readDeviceIdentityKeyRecord(body.deviceIdentityKey ?? {});
    if (!recorded) throw new Error("the vector carries no readable key");

    // The tests above left a vault in this tomb; this one starts from none.
    await vfsFlush();
    for (const path of [
      BODY_PATH,
      HEADER_PATH,
      INDEX_PATH,
      MIGRATION_MARKER_PATH,
      DEVICE_IDENTITY_KEY_PATH,
    ]) {
      kvDelete(tombFileKey(PERSONAL_TOMB, path));
    }
    const locks = webLocksDouble();
    vi.stubGlobal("navigator", { locks });
    const carrier = { ...deviceKeyCarrier };
    try {
      const store = new VaultStore();
      await store.create("an unrelated master passphrase 2026");
      installDeviceKeyCarrier(() => bodyPortOf(store));
      // The file is a backup; its sealed export form is what a restore reads.
      await store.importSealed(sealedVaultText(vector.file), fixture.password, {
        adoptIdentity: true,
      });
      expect((await ensureDeviceIdentityKey(PERSONAL_TOMB)).principalId).toBe(
        `prn_${recorded.keyId}`,
      );
      store.lock();
    } finally {
      Object.assign(deviceKeyCarrier, carrier);
      vi.unstubAllGlobals();
    }
  });
});
