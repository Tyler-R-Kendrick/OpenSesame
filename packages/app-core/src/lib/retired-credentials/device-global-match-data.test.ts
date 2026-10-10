/** Actual fixed Argon2id and strict codecs; explicit inventory DATA double grants no owner authority. */
import { beforeAll, expect, it } from "vitest";
import { copyNodePhysicalRetirement } from "../vault/node-physical-retirement-data.js";
import type { PhysicalRetiredCredentialRecord } from "../vault/physical-device-record-port.js";
import { deriveRetiredVerifier } from "./argon-verifier.js";
import { matchDeviceRetiredCredentialData } from "./device-global-match-data.js";
import { RETIRED_CREDENTIAL_MATCHING_V2 } from "./records-v2.js";
const candidate = "retired exact scalar password";
let wire = "";
beforeAll(async () => {
  const salt = new Uint8Array(16).fill(7);
  const verifier = await deriveRetiredVerifier(candidate, salt);
  salt.fill(0);
  wire = JSON.stringify({
    v: 2,
    context: {
      v: 2,
      format: "pages-auth-header-v1",
      tomb: "personal",
      purpose: "human-vault-root",
      vaultId: "original-vault",
      rootKeyId: "original-root",
      rootEpoch: 1,
      generationSha256: "a".repeat(64),
    },
    matching: RETIRED_CREDENTIAL_MATCHING_V2,
    traps: [
      {
        id: "selected-retired",
        createdAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-02T00:00:00.000Z",
        response: "synthetic_decoy",
        salt: "BwcHBwcHBwcHBwcHBwcHBw==",
        verifier,
      },
    ],
    events: [],
  });
});
function inventory() {
  let captures = 0;
  let validations = 0;
  const row: PhysicalRetiredCredentialRecord = {
    tomb: "personal",
    wire,
    ciphertextDigest: "b".repeat(64),
    physicalName: "original-personal-retired",
  };
  const data = {
    check: () => {},
    revalidateRoot: async () => {
      validations++;
    },
    captureRetiredCredentialInventory: async () => {
      captures++;
      return [row];
    },
  };
  return {
    data,
    row,
    captures: () => captures,
    validations: () => validations,
  };
}
it("retains an exact expired match as DATA without granting current authority", async () => {
  const original = inventory();
  const found = await matchDeviceRetiredCredentialData(
    original.data,
    candidate,
    () => {},
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    tomb: "personal",
    trapId: "selected-retired",
    expiresAt: "2025-01-02T00:00:00.000Z",
    response: "synthetic_decoy",
  });
  expect(Object.isFrozen(found)).toBe(true);
  expect(Object.isFrozen(found[0])).toBe(true);
  expect(original.captures()).toBe(2);
  expect(original.validations()).toBe(2);
  expect(
    await matchDeviceRetiredCredentialData(
      original.data,
      `${candidate}!`,
      () => {},
    ),
  ).toEqual([]);
});
it("refuses changed physical inventory after genuine Argon matching", async () => {
  const original = inventory();
  const capture = original.data.captureRetiredCredentialInventory;
  let reads = 0;
  original.data.captureRetiredCredentialInventory = async () => {
    reads++;
    const rows = await capture();
    return reads === 1
      ? rows
      : [{ ...original.row, ciphertextDigest: "c".repeat(64) }];
  };
  await expect(
    matchDeviceRetiredCredentialData(original.data, candidate, () => {}),
  ).rejects.toThrow(/unavailable/);
});
it("refuses oversized inventory before matching and validates exact original reader method identity", async () => {
  const original = inventory();
  original.data.captureRetiredCredentialInventory = async () =>
    Array.from({ length: 33 }, () => original.row);
  await expect(
    matchDeviceRetiredCredentialData(original.data, candidate, () => {}),
  ).rejects.toThrow(/unavailable/);
  const second = inventory();
  const revalidate = second.data.revalidateRoot;
  second.data.revalidateRoot = async () => {
    await revalidate();
    second.data.captureRetiredCredentialInventory = async () => [];
  };
  await expect(
    matchDeviceRetiredCredentialData(second.data, candidate, () => {}),
  ).rejects.toThrow(/unavailable/);
});
it("retirement DATA refuses current generations, ambiguous inventory and traversal", () => {
  const record = {
    scope: "vault" as const,
    path: "old/body.json",
    digest: "d".repeat(64),
  };
  const accepted = copyNodePhysicalRetirement({
    version: 1,
    phase: "pending",
    records: [record],
  });
  expect(Object.isFrozen(accepted)).toBe(true);
  expect(Object.isFrozen(accepted.records[0])).toBe(true);
  for (const records of [
    [{ ...record, path: "opensesame-generation.v1.json" }],
    [record, { ...record }],
    [{ ...record, path: "../body.json" }],
  ])
    expect(() =>
      copyNodePhysicalRetirement({ version: 1, phase: "pending", records }),
    ).toThrow();
});
