import { describe, expect, it } from "vitest";
import { readPagesRetiredCredentialHeader } from "./context-v2-header.js";
import {
  RETIRED_CREDENTIAL_CONTEXT_FORMAT,
  deriveRetiredCredentialContextV2 as derive,
  encodeRetiredCredentialContextV2 as encode,
  parseRetiredCredentialContextV2 as parse,
} from "./context-v2.js";
import vectors from "./fixtures/context-v2-vectors.json";

const firstVector = vectors.vectors[0];
if (!firstVector) throw new Error("Public context vector missing");
const header = readPagesRetiredCredentialHeader(firstVector.rawHeaderJson);
const context = () => derive("personal", JSON.stringify(header));
describe("format-specific Pages context vector boundaries", () => {
  it.each(vectors.vectors)(
    "matches $name across the declared Pages data protocol",
    async (vector) => {
      const value = await derive("personal", vector.rawHeaderJson);
      expect(value).toEqual(vector.expectedContext);
      expect(encode(value)).toBe(vector.canonicalWire);
      expect(parse(vector.canonicalWire)).toEqual(value);
      expect(
        vector.generationInputUtf8.startsWith(
          `opensesame/retired-credential/context-header/v2\0${RETIRED_CREDENTIAL_CONTEXT_FORMAT}\0`,
        ),
      ).toBe(true);
    },
  );
  it("requires the supported format even when the actual identity tuple is unchanged", async () => {
    const value = await context();
    for (const format of [
      undefined,
      vectors.unsupportedFormat,
      "pages-auth-header-v2",
    ]) {
      expect(() => encode({ ...value, format })).toThrow(
        "context is unavailable",
      );
      expect(() => parse(JSON.stringify({ ...value, format }))).toThrow(
        "context is unavailable",
      );
    }
    expect(value.generationSha256).not.toBe(
      "2c2b4b3958b99698a2bec77909fc23dc92d0c9348b856cbd8dc51e113268b229",
    );
  });
  it("refuses native-shaped nonce/manifests instead of projecting them into Pages metadata", async () => {
    const record = header.protection.records[0];
    if (!record || record.kind !== "recovery-key")
      throw new Error("Invalid public vector");
    const nativeManifest = {
      ...header.protection,
      records: [
        {
          ...record,
          wrap: { nonceB64: btoa("n".repeat(24)), ctB64: record.wrap.ctB64 },
        },
      ],
    };
    await expect(
      derive("personal", JSON.stringify(nativeManifest)),
    ).rejects.toThrow("context is unavailable");
    await expect(
      derive(
        "personal",
        JSON.stringify({ ...header, protection: nativeManifest }),
      ),
    ).rejects.toThrow("context is unavailable");
  });
});
