import { describe, expect, it } from "vitest";
import { openRootCapsule } from "../vault/protection/capsule.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import { readPagesRetiredCredentialHeader } from "./context-v2-header.js";
import vectors from "./fixtures/context-v2-vectors.json";

const firstVector = vectors.vectors[0];
if (!firstVector) throw new Error("Missing context vector fixture.");

describe("inactive Pages public authentication header profile", () => {
  it("preserves own map keys covered by the genuine manifest MAC", async () => {
    const vector = vectors.vectors.find(
      (v) => v.name === "pages-utf16-cloud-public-metadata",
    );
    if (!vector) throw new Error("Missing AWS metadata fixture.");
    const header = readPagesRetiredCredentialHeader(vector.rawHeaderJson);
    const aws = header.protection.records.find((r) => r.kind === "aws-kms");
    if (!aws || aws.kind !== "aws-kms") throw new Error("Missing AWS record.");
    Object.defineProperty(aws.encryptionContext, "__proto__", {
      value: "authenticated public metadata",
      enumerable: true,
    });
    const root = new Uint8Array(32).fill(17);
    try {
      header.protection = await sealAuthenticatedManifest(
        root,
        manifestWithoutAuth(header.protection),
      );
      const parsed = readPagesRetiredCredentialHeader(JSON.stringify(header));
      const row = parsed.protection.records.find((r) => r.kind === "aws-kms");
      if (!row || row.kind !== "aws-kms")
        throw new Error("Missing parsed AWS.");
      expect(Object.hasOwn(row.encryptionContext, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(row.encryptionContext)).toBe(
        Object.prototype,
      );
      await verifyManifestAuth(root, parsed.protection);
      row.encryptionContext.__proto__ = "changed public metadata";
      await expect(verifyManifestAuth(root, parsed.protection)).rejects.toThrow(
        "Manifest authentication failed",
      );
    } finally {
      root.fill(0);
    }
  });
  it.each(vectors.vectors)(
    "retains $name with genuine known-key MAC and capsule bytes",
    async (vector) => {
      const parsed = readPagesRetiredCredentialHeader(vector.rawHeaderJson);
      const root = new Uint8Array(32).fill(17);
      await verifyManifestAuth(root, parsed.protection);
      const record = parsed.protection.records[0];
      if (
        !record ||
        (record.kind !== "recovery-key" && record.kind !== "aws-kms")
      )
        throw new Error("Invalid public vector");
      const wrap =
        record.kind === "recovery-key" ? record.wrap : record.localCapsule;
      const kek = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(34),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      expect(
        await openRootCapsule(
          kek,
          {
            vaultId: parsed.protection.vaultId,
            rootKeyId: parsed.protection.rootKeyId,
            rootEpoch: parsed.protection.rootEpoch,
            purpose: parsed.protection.purpose,
            protectorId: record.protectorId,
          },
          wrap,
        ),
      ).toEqual(root);
      expect(parsed.protection.purpose).toBe("human-vault-root");
      expect(parsed.protection.vaultId).toBe(vector.expectedContext.vaultId);
      expect(parsed.protection.rootKeyId).toBe(
        vector.expectedContext.rootKeyId,
      );
      expect(parsed.protection.rootEpoch).toBe(
        vector.expectedContext.rootEpoch,
      );
    },
  );
  it("refuses legacy, portable, workload and contradictory factor declarations", () => {
    const header = readPagesRetiredCredentialHeader(firstVector.rawHeaderJson);
    for (const raw of [
      "",
      "null",
      "{}",
      JSON.stringify({ v: 1, createdAt: header.createdAt }),
    ])
      expect(() => readPagesRetiredCredentialHeader(raw)).toThrow(
        "context is unavailable",
      );
    for (const input of [
      {
        ...header,
        protection: { ...header.protection, purpose: "workload-root" },
      },
      {
        ...header,
        protection: { ...header.protection, legacyGates: undefined },
      },
      {
        ...header,
        protection: {
          ...header.protection,
          legacyGates: { ...header.protection.legacyGates, totpEnrolled: true },
        },
      },
      { ...header, protection: { ...header.protection, authB64: undefined } },
      {
        ...header,
        protection: { ...header.protection, preferredProtectorId: "missing" },
      },
      {
        ...header,
        protection: {
          ...header.protection,
          records: [...header.protection.records, header.protection.records[0]],
        },
      },
      { ...header, plaintextOwnerSecret: "refused private data" },
    ])
      expect(() =>
        readPagesRetiredCredentialHeader(JSON.stringify(input)),
      ).toThrow("context is unavailable");
  });
  it("refuses native recovery nonce metadata instead of inferring a Pages IV", () => {
    const header = readPagesRetiredCredentialHeader(firstVector.rawHeaderJson);
    const record = header.protection.records[0];
    if (!record || record.kind !== "recovery-key")
      throw new Error("Invalid public vector");
    const protection = {
      ...header.protection,
      records: [
        {
          ...record,
          wrap: { nonceB64: btoa("n".repeat(24)), ctB64: record.wrap.ctB64 },
        },
      ],
    };
    expect(() =>
      readPagesRetiredCredentialHeader(JSON.stringify(protection)),
    ).toThrow("context is unavailable");
    expect(() =>
      readPagesRetiredCredentialHeader(
        JSON.stringify({ ...header, protection }),
      ),
    ).toThrow("context is unavailable");
  });
});
