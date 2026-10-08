import type {
  AuthenticatedLegacyGates,
  VaultUnlocks,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { sealAuthenticatedManifest } from "../vault/protection/manifest-auth.js";
import { verifyHumanVaultData } from "./human-vault-data.js";
import {
  absent,
  tomb,
  unavailable,
  useFixture,
} from "./human-vault-data.test-support.js";

describe("authenticated data integer and policy boundaries", () => {
  it("rejects MAC-valid unsafe epochs and manifest revisions", () =>
    useFixture(async (value) => {
      const manifest = value.header.protection;
      if (!manifest) throw new Error("Missing fixture manifest");
      const { authB64: _drop, ...rest } = manifest;
      for (const field of ["rootEpoch", "revision"] as const) {
        for (const number of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
          const protection = await sealAuthenticatedManifest(value.root, {
            ...rest,
            [field]: number,
          });
          await expect(
            verifyHumanVaultData(
              tomb,
              JSON.stringify({ ...value.header, protection }),
              value.body,
              value.root,
            ),
          ).rejects.toThrow(unavailable);
        }
      }
      const protection = await sealAuthenticatedManifest(value.root, {
        ...rest,
        rootEpoch: Number.MAX_SAFE_INTEGER,
        revision: Number.MAX_SAFE_INTEGER,
      });
      const metadata = await verifyHumanVaultData(
        tomb,
        JSON.stringify({ ...value.header, protection }),
        value.body,
        value.root,
      );
      expect(metadata.rootEpoch).toBe(Number.MAX_SAFE_INTEGER);
      expect(metadata.manifestRevision).toBe(Number.MAX_SAFE_INTEGER);
    }));

  it("rejects malformed or unsafe outer header revisions", () =>
    useFixture(async (value) => {
      for (const bodyRev of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "0"]) {
        await expect(
          verifyHumanVaultData(
            tomb,
            JSON.stringify({ ...value.header, bodyRev }),
            value.body,
            value.root,
          ),
        ).rejects.toThrow(unavailable);
      }
    }));

  it("requires exact agreement for every authenticated factor-presence flag", () =>
    useFixture(async (value) => {
      const manifest = value.header.protection;
      if (!manifest) throw new Error("Missing fixture manifest");
      const { authB64: _drop, ...rest } = manifest;
      const since = "2026-10-08T00:00:00.000Z";
      const cases: ReadonlyArray<
        readonly [keyof AuthenticatedLegacyGates, VaultUnlocks]
      > = [
        [
          "totpEnrolled",
          { totp: { secretWrap: value.body, digits: 6, period: 30 } },
        ],
        ["emailEnrolled", { email: { toWrap: value.body, since } }],
        ["smsEnrolled", { sms: { toWrap: value.body, since } }],
        [
          "recoveryCodesEnrolled",
          { recovery: { codesWrap: value.body, since, total: 10 } },
        ],
      ];
      for (const [flag, unlocks] of cases) {
        await expect(
          verifyHumanVaultData(
            tomb,
            JSON.stringify({ ...value.header, unlocks }),
            value.body,
            value.root,
          ),
        ).rejects.toThrow(unavailable);
        const protection = await sealAuthenticatedManifest(value.root, {
          ...rest,
          legacyGates: { ...absent, [flag]: true },
        });
        await expect(
          verifyHumanVaultData(
            tomb,
            JSON.stringify({ ...value.header, protection }),
            value.body,
            value.root,
          ),
        ).rejects.toThrow(unavailable);
        const metadata = await verifyHumanVaultData(
          tomb,
          JSON.stringify({ ...value.header, protection, unlocks }),
          value.body,
          value.root,
        );
        expect(metadata.gates[flag]).toBe(true);
        // Synthetic records establish presence only; no delivery, code or factor verdict.
      }
    }));

  it("refuses missing, extra or nonboolean policy instead of coercion", () =>
    useFixture(async (value) => {
      const protection = value.header.protection;
      if (!protection) throw new Error("Missing fixture manifest");
      for (const legacyGates of [
        undefined,
        { ...absent, totpEnrolled: "false" },
        { ...absent, totpEnrolled: null },
        { ...absent, unexpectedFactor: true },
        {
          emailEnrolled: false,
          smsEnrolled: false,
          recoveryCodesEnrolled: false,
        },
      ]) {
        await expect(
          verifyHumanVaultData(
            tomb,
            JSON.stringify({
              ...value.header,
              protection: { ...protection, legacyGates },
            }),
            value.body,
            value.root,
          ),
        ).rejects.toThrow(unavailable);
      }
    }));
});
