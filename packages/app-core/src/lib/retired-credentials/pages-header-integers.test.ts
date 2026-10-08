import {
  type VaultHeader,
  createVault,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "../vault/protection/migrate-legacy.js";
import { assertPagesHeaderIntegerProfile as assertIntegers } from "./pages-header-integers.js";

const PASSWORD = "integer profile real owner 57384";
let header: VaultHeader;
let root: Uint8Array;
function fixtureManifest(value: VaultHeader) {
  const manifest = value.protection;
  if (!manifest) throw new Error("Missing fixture manifest");
  return manifest;
}
beforeAll(async () => {
  const made = await createVault(PASSWORD);
  root = made.rawVaultKey;
  header = {
    ...made.header,
    protection: await sealAuthenticatedManifest(
      root,
      migrateLegacyHeaderToManifest({
        header: made.header,
        rootEpoch: 1,
        passkeyRpId: "owner.example.invalid",
      }).manifest,
    ),
  };
});
function epoch(raw: string, token: string): string {
  const replaced = raw.replace(/"rootEpoch":[0-9]+/, `"rootEpoch":${token}`);
  if (replaced === raw) throw new Error("Epoch replacement failed");
  return replaced;
}
describe("inactive Pages integer lexical contract", () => {
  it("accepts a genuinely created password header and authenticated manifest", async () => {
    await verifyManifestAuth(root, fixtureManifest(header));
    expect(await unwrapRawVaultKeyFromPassword(header, PASSWORD)).toEqual(root);
    expect(() =>
      assertIntegers(JSON.stringify({ ...header, bodyRev: 0 })),
    ).not.toThrow();
  });
  it("refuses a fractional epoch even when native parsing preserves the genuine manifest MAC", async () => {
    const raw = epoch(JSON.stringify(header), "1.0000000000000001");
    const parsed: VaultHeader = JSON.parse(raw);
    expect(fixtureManifest(parsed).rootEpoch).toBe(1);
    await verifyManifestAuth(root, fixtureManifest(parsed));
    expect(() => assertIntegers(raw)).toThrow("context is unavailable");
  });
  it("preserves exact MAX_SAFE but refuses its rounded fractional alias before parsing", async () => {
    const protection = await sealAuthenticatedManifest(root, {
      ...manifestWithoutAuth(fixtureManifest(header)),
      rootEpoch: Number.MAX_SAFE_INTEGER,
    });
    await verifyManifestAuth(root, protection);
    const raw = JSON.stringify({ ...header, protection });
    expect(() => assertIntegers(raw)).not.toThrow();
    const alias = epoch(raw, "9007199254740991.1");
    const parsed: VaultHeader = JSON.parse(alias);
    expect(fixtureManifest(parsed).rootEpoch).toBe(Number.MAX_SAFE_INTEGER);
    await verifyManifestAuth(root, fixtureManifest(parsed));
    expect(() => assertIntegers(alias)).toThrow("context is unavailable");
  });
  it.each([
    "-0",
    "-1",
    "1.0",
    "1e0",
    "1E+0",
    "1e-400",
    "01",
    "+1",
    "9007199254740992",
    "9007199254740993",
    "1".repeat(17),
  ])("refuses raw epoch %s without calling a parser or digest", (token) => {
    const raw = epoch(JSON.stringify(header), token);
    const parser = vi.spyOn(JSON, "parse");
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      expect(() => assertIntegers(raw)).toThrow("context is unavailable");
      expect(parser).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
      digest.mockRestore();
    }
  });
  it("leaves numeric text and escaped quotes inside actual public hint metadata opaque", () => {
    const raw = JSON.stringify({
      ...header,
      hint: 'public "-1.2e+3" \\ 9007199254740993',
      bodyRev: 0,
    });
    expect(() => assertIntegers(raw)).not.toThrow();
  });
  it("bounds its scan and refuses caller objects without traversing getters", () => {
    let touched = false;
    const value = {
      get header() {
        touched = true;
        throw new Error("getter");
      },
    };
    expect(() => Reflect.apply(assertIntegers, undefined, [value])).toThrow(
      "context is unavailable",
    );
    expect(touched).toBe(false);
    expect(() =>
      assertIntegers(JSON.stringify(header).padEnd(65537, " ")),
    ).toThrow("context is unavailable");
    expect(() =>
      assertIntegers(JSON.stringify(header).padEnd(65536, " ")),
    ).not.toThrow();
  });
});
