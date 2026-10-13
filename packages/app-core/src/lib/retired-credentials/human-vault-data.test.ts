import {
  bytesToB64,
  importVaultKey,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { sealAuthenticatedManifest } from "../vault/protection/manifest-auth.js";
import { verifyHumanVaultData } from "./human-vault-data.js";
import {
  type Fixture,
  absent,
  tomb,
  unavailable,
  useFixture,
} from "./human-vault-data.test-support.js";

const verify = (value: Fixture) =>
  verifyHumanVaultData(
    tomb,
    JSON.stringify(value.header),
    value.body,
    value.root,
  );

describe("inactive human vault data verification using real crypto", () => {
  it("verifies a genuinely unwrapped key and a present initialized empty body", () =>
    useFixture(async (value) => {
      const original = new Uint8Array(value.root);
      const metadata = await verify(value);
      expect(metadata).toMatchObject({
        vaultId: "opaque-vault-id",
        rootKeyId: "opaque-root-id",
        rootEpoch: 3,
        manifestRevision: 5,
        bodyRevision: 0,
        gates: absent,
      });
      expect(metadata.headerDigestB64).toHaveLength(44);
      expect(metadata.bodyDigestB64).toHaveLength(44);
      expect(Object.keys(metadata).sort()).toEqual([
        "bodyDigestB64",
        "bodyRevision",
        "gates",
        "headerDigestB64",
        "manifestRevision",
        "rootEpoch",
        "rootKeyId",
        "vaultId",
      ]);
      expect(Object.isFrozen(metadata)).toBe(true);
      expect(Object.isFrozen(metadata.gates)).toBe(true);
      expect(value.root).toEqual(original);
      expect(await verify(value)).toEqual(metadata);
      original.fill(0);
    }));

  it("refuses missing body even without any recorded writes", () =>
    useFixture(async (value) => {
      await expect(
        verifyHumanVaultData(
          tomb,
          JSON.stringify(value.header),
          null,
          value.root,
        ),
      ).rejects.toThrow(unavailable);
    }));

  it("refuses modified MAC, signed root IDs and wrong root without mutation", () =>
    useFixture(async (value) => {
      const manifest = value.header.protection;
      if (!manifest) throw new Error("Missing fixture manifest");
      for (const protection of [
        { ...manifest, authB64: bytesToB64(new Uint8Array(32)) },
        { ...manifest, rootKeyId: "substituted" },
        { ...manifest, vaultId: "substituted" },
        { ...manifest, rootEpoch: 4 },
      ])
        await expect(
          verify({ ...value, header: { ...value.header, protection } }),
        ).rejects.toThrow(unavailable);
      const wrong = new Uint8Array(32).fill(7);
      try {
        await expect(verify({ ...value, root: wrong })).rejects.toThrow(
          unavailable,
        );
        expect(wrong).toEqual(new Uint8Array(32).fill(7));
      } finally {
        wrong.fill(0);
      }
    }));

  it("refuses authenticated workload purpose and unauthenticated legacy headers", () =>
    useFixture(async (value) => {
      const manifest = value.header.protection;
      if (!manifest) throw new Error("Missing fixture manifest");
      const { authB64: _drop, ...rest } = manifest;
      const workload = await sealAuthenticatedManifest(value.root, {
        ...rest,
        purpose: "workload-root",
      });
      await expect(
        verify({ ...value, header: { ...value.header, protection: workload } }),
      ).rejects.toThrow(unavailable);
      const { protection: _legacy, ...header } = value.header;
      await expect(verify({ ...value, header })).rejects.toThrow(unavailable);
    }));

  it("requires the actual bound body with the exact tomb and body path", () =>
    useFixture(async (value) => {
      await expect(
        verifyHumanVaultData(
          "other",
          JSON.stringify(value.header),
          value.body,
          value.root,
        ),
      ).rejects.toThrow(unavailable);
      const key = await importVaultKey(value.root);
      for (const binding of [undefined, vaultSealBinding(tomb, "other")]) {
        const body = await sealJson(
          key,
          { v: 1, items: [], folders: [] },
          binding,
        );
        await expect(verify({ ...value, body })).rejects.toThrow(unavailable);
      }
      const body = {
        ...value.body,
        ctB64: `${value.body.ctB64.startsWith("A") ? "B" : "A"}${value.body.ctB64.slice(1)}`,
      };
      await expect(verify({ ...value, body })).rejects.toThrow(unavailable);
    }));

  it("refuses rollback and malformed authenticated body revisions", () =>
    useFixture(async (value) => {
      const key = await importVaultKey(value.root);
      await expect(
        verify({ ...value, header: { ...value.header, bodyRev: 1 } }),
      ).rejects.toThrow(unavailable);
      for (const rev of [-1, 0.5, "1", null]) {
        const body = await sealJson(
          key,
          { v: 1, rev, items: [], folders: [] },
          vaultSealBinding(tomb, "body"),
        );
        await expect(verify({ ...value, body })).rejects.toThrow(unavailable);
      }
      const body = await sealJson(
        key,
        { v: 1, rev: 2, items: [], folders: [] },
        vaultSealBinding(tomb, "body"),
      );
      expect(
        (
          await verify({
            ...value,
            header: { ...value.header, bodyRev: 1 },
            body,
          })
        ).bodyRevision,
      ).toBe(2);
    }));

  it("refuses disagreement with authenticated factor presence flags", () =>
    useFixture(async (value) => {
      const gate = { secretWrap: value.body, digits: 6, period: 30 } as const;
      await expect(
        verify({
          ...value,
          header: { ...value.header, unlocks: { totp: gate } },
        }),
      ).rejects.toThrow(unavailable);
      const manifest = value.header.protection;
      if (!manifest) throw new Error("Missing fixture manifest");
      const { authB64: _drop, ...rest } = manifest;
      const protection = await sealAuthenticatedManifest(value.root, {
        ...rest,
        legacyGates: { ...absent, totpEnrolled: true },
      });
      await expect(
        verify({ ...value, header: { ...value.header, protection } }),
      ).rejects.toThrow(unavailable);
      const metadata = await verify({
        ...value,
        header: { ...value.header, protection, unlocks: { totp: gate } },
      });
      expect(metadata.gates.totpEnrolled).toBe(true);
      // Presence is data consistency only: this synthetic gate has no completed factor.
    }));
});
