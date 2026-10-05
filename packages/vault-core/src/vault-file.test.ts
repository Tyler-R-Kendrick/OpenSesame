/**
 * The vault-file reader over the golden vectors (vault-format-v1 §7): every
 * vector opens with its password to the recorded tomb, binding, revision and
 * items, lists each item's path, and prints no field value.
 */
import { type JsonValue, isString, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/conformance/vault-vectors.json" with {
  type: "json",
};
import { VaultCorruptError, WrongPasswordError } from "./crypto.js";
import { unwrapRawVaultKeyFromPassword } from "./crypto.js";
import { readDeviceIdentityKeyRecord } from "./device-key.js";
import {
  openVaultBody,
  openVaultFile,
  readVaultFile,
  summarizeVaultBody,
} from "./vault-file.js";

const vectors = Object.entries(fixture.vectors);

/** The kind a recorded (possibly legacy) kind opens as. */
const current = (kind: string): string => (kind === "login" ? "account" : kind);

/** Every string anywhere in a JSON value. */
function stringLeaves(value: JsonValue): string[] {
  const found: string[] = [];
  JSON.parse(JSON.stringify(value), (_key, leaf: JsonValue) => {
    if (isString(leaf)) found.push(leaf);
    return leaf;
  });
  return found;
}

describe("openVaultFile over the golden vectors", () => {
  it.each(vectors)("%s opens to its recorded summary", async (_n, v) => {
    const opened = await openVaultFile(v.file, fixture.password);
    // A vault written before ADR 0172 holds `login` items; they open as accounts.
    expect(
      opened.items.map(({ id, name, kind }) => ({ id, name, kind })),
    ).toEqual(
      v.expect.items.map((item) => ({ ...item, kind: current(item.kind) })),
    );
    expect(opened).toMatchObject({
      tomb: v.expect.tomb,
      bound: v.expect.bound,
      rev: v.expect.rev,
    });
    // A concealed file is named and never shown (ADR 0160 §5).
    expect(opened.concealed).toEqual(
      "concealed" in v.expect ? v.expect.concealed : [],
    );
    for (const item of opened.items) expect(item.path).toContain(item.name);
  });

  it("opens every legacy login vector as accounts, with none left", async () => {
    const legacyVectors = vectors.filter(([, v]) =>
      v.expect.items.some((item) => item.kind === "login"),
    );
    expect(legacyVectors.length).toBeGreaterThan(0);
    for (const [, v] of legacyVectors) {
      const sealed = readVaultFile(v.file);
      const raw = await unwrapRawVaultKeyFromPassword(
        sealed.header,
        fixture.password,
      );
      const { body } = await openVaultBody(sealed, raw);
      const kinds = body.items.map((item) => item.kind);
      expect(kinds).not.toContain("login");
      expect(kinds).toContain("account");
      const opened = await openVaultFile(v.file, fixture.password);
      expect(opened.items.map((item) => item.kind)).not.toContain("login");
    }
  });

  it.each(vectors)("%s lists no field value", async (_n, v) => {
    const printed = JSON.stringify(
      await openVaultFile(v.file, fixture.password),
    );
    const sealed = readVaultFile(v.file);
    const raw = await unwrapRawVaultKeyFromPassword(
      sealed.header,
      fixture.password,
    );
    const { body } = await openVaultBody(sealed, raw);
    const values = body.items.flatMap(
      ({ id: _i, name: _n2, kind: _k, ...rest }) =>
        stringLeaves(overlapCast(rest)).filter((value) => value.length >= 6),
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(printed).not.toContain(value);
    // Nor any part of the device identity key a body carries.
    const key = body.deviceIdentityKey;
    if (key !== undefined) {
      for (const value of stringLeaves(key).filter((x) => x.length >= 6)) {
        expect(printed).not.toContain(value);
      }
      expect(printed).not.toContain("deviceIdentityKey");
    }
  });

  it("holds a vector whose body carries the device identity key", async () => {
    const carrying = vectors.filter(([, v]) => "concealed" in v.expect);
    expect(carrying.map(([name]) => name)).toEqual(["backup-device-identity"]);
    const [, v] = carrying[0] ?? [];
    if (!v) throw new Error("no vector carries a key");
    const sealed = readVaultFile(v.file);
    const raw = await unwrapRawVaultKeyFromPassword(
      sealed.header,
      fixture.password,
    );
    const { body } = await openVaultBody(sealed, raw);
    expect(
      readDeviceIdentityKeyRecord(body.deviceIdentityKey ?? {}),
    ).not.toBeNull();
    // The sealed file shows nothing of it to someone without the vault key.
    expect(v.file).not.toContain("privateJwkJson");
    expect(v.file).not.toContain("device-identity");
  });

  it("refuses the wrong password and anything that is not a vault file", async () => {
    const [, first] = vectors[0] ?? [];
    if (!first) throw new Error("no vectors");
    await expect(
      openVaultFile(first.file, "not the password"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(() => readVaultFile("{}")).toThrow(VaultCorruptError);
    expect(() => readVaultFile("not json")).toThrow(VaultCorruptError);
  });
});

describe("which bodies list the device identity key", () => {
  const sealed = readVaultFile(fixture.vectors["export-personal"].file);

  // The same rows the Rust reader runs (`crates/human-vault`, `body.rs`): a
  // `null` key is absent in both, any other value is listed by name.
  it.each(fixture.concealedBodies.map((row) => [row.name, row] as const))(
    "%s",
    (_name, row) => {
      const listed = summarizeVaultBody(sealed, overlapCast(row.body), true);
      expect(listed.concealed).toEqual(row.concealed);
    },
  );
});
