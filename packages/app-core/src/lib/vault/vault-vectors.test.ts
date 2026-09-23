/**
 * Golden vault vectors must open unchanged (ADR 0133 §7). The fixture was
 * emitted by `scripts/emit-vault-vectors.mjs` before the shared-core move; a
 * failure here is a format break, never a reason to regenerate it.
 */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  b64ToBytes,
  unwrapRawVaultKeyFromPassword,
} from "./crypto.js";
import fixture from "./fixtures/vault-vectors.json";
import type { VaultBody } from "./model.js";
import { VaultStore } from "./store.js";
import {
  listPasskeyUnlockRecords,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
} from "./unlock-methods.js";
import {
  type SealedVaultFile,
  openVaultBody,
  openVaultFile,
  readVaultFile,
} from "./vault-file.js";

type Expectation = {
  tomb: string;
  bound: boolean;
  rev: number | null;
  items: { id: string; name: string; kind: string }[];
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
  };
}

const vectors = Object.entries(fixture.vectors);

/** Every string anywhere under `value`. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringLeaves);
}

describe("golden vault vectors", () => {
  it.each(vectors)("%s opens with the password", async (_name, vector) => {
    const opened = openEnvelope(vector.file);
    const raw = await unwrapRawVaultKeyFromPassword(
      opened.header,
      fixture.password,
    );
    const { body, bound } = await openBody(raw, opened);
    expect(summarize(body, bound, opened.tomb)).toEqual(vector.expect);
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
    expect(summarize(body, bound, opened.tomb)).toEqual(vector.expect);
  });

  it("opens the project body through its passkey PRF wrap", async () => {
    const vector = fixture.vectors["backup-project"];
    const opened = openEnvelope(vector.file);
    const [record] = listPasskeyUnlockRecords(opened.header.unlocks);
    if (!record) throw new Error("vector has no passkey wrap");
    const prf = b64ToBytes(fixture.prfOutputB64);
    const raw = await unwrapVaultKeyWithPrf(record, prf.slice().buffer);
    const { body, bound } = await openBody(raw, opened);
    expect(summarize(body, bound, opened.tomb)).toEqual(vector.expect);
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
    store.lock();
  });

  it.each(vectors)("%s lists names and paths, never values", async (_n, v) => {
    const opened = await openVaultFile(v.file, fixture.password);
    expect(
      opened.items.map(({ id, name, kind }) => ({ id, name, kind })),
    ).toEqual(v.expect.items);
    expect(opened).toMatchObject({
      tomb: v.expect.tomb,
      bound: v.expect.bound,
      rev: v.expect.rev,
    });
    for (const item of opened.items) expect(item.path).toContain(item.name);
    const printed = JSON.stringify(opened);
    const body = await openBody(
      await unwrapRawVaultKeyFromPassword(
        readVaultFile(v.file).header,
        fixture.password,
      ),
      readVaultFile(v.file),
    );
    const values = body.body.items.flatMap((item) => {
      const { id: _id, name: _name, kind: _kind, ...rest } = item;
      return stringLeaves(rest).filter((value) => value.length >= 6);
    });
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(printed).not.toContain(value);
  });

  it("refuses anything that is not a vault file", () => {
    expect(() => readVaultFile("{}")).toThrow(VaultCorruptError);
    expect(() => readVaultFile("not json")).toThrow(VaultCorruptError);
  });
});
