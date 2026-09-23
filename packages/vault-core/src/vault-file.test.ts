/**
 * The vault-file reader over the golden vectors (vault-format-v1 §7): every
 * vector opens with its password to the recorded tomb, binding, revision and
 * items, lists each item's path, and prints no field value.
 */
import { type JsonValue, isString, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { VaultCorruptError, WrongPasswordError } from "./crypto.js";
import { unwrapRawVaultKeyFromPassword } from "./crypto.js";
import fixture from "./fixtures/vault-vectors.json" with { type: "json" };
import { openVaultBody, openVaultFile, readVaultFile } from "./vault-file.js";

const vectors = Object.entries(fixture.vectors);

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
    expect(
      opened.items.map(({ id, name, kind }) => ({ id, name, kind })),
    ).toEqual(v.expect.items);
    expect(opened).toMatchObject({
      tomb: v.expect.tomb,
      bound: v.expect.bound,
      rev: v.expect.rev,
    });
    for (const item of opened.items) expect(item.path).toContain(item.name);
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
