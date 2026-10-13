import { Buffer } from "node:buffer";
import { bytesToB64 } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { verifyHumanVaultData } from "./human-vault-data.js";
import {
  tomb,
  unavailable,
  useFixture,
} from "./human-vault-data.test-support.js";

it("keeps a caller-owned Buffer root intact on genuine successful verification and failed MAC", () =>
  useFixture(async (value) => {
    const root = Buffer.from(value.root);
    const original = Buffer.from(root);
    try {
      const header = JSON.stringify(value.header);
      await expect(
        verifyHumanVaultData(tomb, header, value.body, root),
      ).resolves.toMatchObject({ vaultId: "opaque-vault-id" });
      expect(root).toEqual(original);
      const manifest = value.header.protection;
      if (!manifest)
        throw new Error("Actual authenticated fixture is missing.");
      await expect(
        verifyHumanVaultData(
          tomb,
          JSON.stringify({
            ...value.header,
            protection: {
              ...manifest,
              authB64: bytesToB64(new Uint8Array(32)),
            },
          }),
          value.body,
          root,
        ),
      ).rejects.toThrow(unavailable);
      expect(root).toEqual(original);
    } finally {
      root.fill(0);
      original.fill(0);
    }
  }));

it("authenticates the primitive body and owned root captured before caller mutation at the first real crypto await", () =>
  useFixture(async (value) => {
    const header = JSON.stringify(value.header);
    const originalBody = { ...value.body };
    const expected = await verifyHumanVaultData(
      tomb,
      header,
      originalBody,
      value.root,
    );
    const suppliedRoot = new Uint8Array(value.root);
    const suppliedBody = { ...value.body };
    const pending = verifyHumanVaultData(
      tomb,
      header,
      suppliedBody,
      suppliedRoot,
    );
    suppliedRoot.fill(0);
    suppliedBody.ivB64 = bytesToB64(new Uint8Array(12));
    suppliedBody.ctB64 = bytesToB64(new Uint8Array(16));
    await expect(pending).resolves.toEqual(expected);
    expect(suppliedRoot).toEqual(new Uint8Array(32));
    await expect(
      verifyHumanVaultData(tomb, header, suppliedBody, value.root),
    ).rejects.toThrow(unavailable);
    await expect(
      verifyHumanVaultData(tomb, header, originalBody, value.root),
    ).resolves.toEqual(expected);
  }));

it("refuses raw duplicate header keys and malformed scalar tombs without exposing crypto details", () =>
  useFixture(async (value) => {
    const header = JSON.stringify(value.header);
    await expect(
      verifyHumanVaultData(tomb, header, value.body, value.root),
    ).resolves.toMatchObject({ bodyRevision: 0 });
    for (const raw of [
      `{"v":1,${header.slice(1)}`,
      header.replace('"vaultId":', '"vaultId":"ignored","\\u0076aultId":'),
    ]) {
      await expect(
        verifyHumanVaultData(tomb, raw, value.body, value.root),
      ).rejects.toThrow(unavailable);
    }
    await expect(
      verifyHumanVaultData("\ud800", header, value.body, value.root),
    ).rejects.toThrow(unavailable);
    await expect(
      verifyHumanVaultData(tomb, header, value.body, value.root),
    ).resolves.toMatchObject({ bodyRevision: 0 });
  }));
