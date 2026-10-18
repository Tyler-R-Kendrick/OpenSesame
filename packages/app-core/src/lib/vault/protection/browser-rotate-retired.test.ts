/** Real Argon2 and root/body crypto; physical inventory/lease delivery is a disclosed double. */
import { isFunction, overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { configureHost, host } from "../../../host.js";
import { createTestHost } from "../../../test-host.js";
import { kvDelete } from "../../kv.js";
import { deriveRetiredVerifier } from "../../retired-credentials/argon-verifier.js";
import { RETIRED_CREDENTIAL_MATCHING_V2 } from "../../retired-credentials/records-v2.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readPlaintextFile,
  readSealedFile,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import type { PhysicalDeviceRecordPort } from "../physical-device-record-port.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
const previous = host();
const retainedPin = "73920146";
afterEach(() => configureHost(previous));
async function actualPinVault() {
  configureHost(createTestHost());
  await vfsFlush();
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  kvDelete(ATTEMPTS_KEY);
  const store = new VaultStore();
  await store.createWithPin("48291037");
  await store.protection.ensureProtectionProjected();
  return store;
}
async function installInventory(retained: boolean) {
  const salt = new Uint8Array(16).fill(7);
  const wire = JSON.stringify({
    v: 2,
    context: {
      v: 2,
      format: "pages-auth-header-v1",
      tomb: "foreign",
      purpose: "human-vault-root",
      vaultId: "oldvault",
      rootKeyId: "oldroot",
      rootEpoch: 1,
      generationSha256: "a".repeat(64),
    },
    matching: RETIRED_CREDENTIAL_MATCHING_V2,
    traps: [
      {
        id: "foreign-expired-trap",
        createdAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-02T00:00:00.000Z",
        response: "synthetic_decoy",
        salt: "BwcHBwcHBwcHBwcHBwcHBw==",
        verifier: await deriveRetiredVerifier(retainedPin, salt),
      },
    ],
    events: [],
  });
  salt.fill(0);
  const held: string[] = [];
  let closed = false;
  let bodyTurns = 0;
  const locks = overlapCast<unknown, LockManager>({
    async request<T>(
      name: string,
      options: { mode: string } | (() => Promise<T>),
      work?: (lock: Lock) => Promise<T>,
    ) {
      if (name.startsWith("opensesame:vault-body:")) {
        expect(held).toContain("opensesame.retired-credentials");
        bodyTurns++;
      }
      held.push(name);
      try {
        if (work)
          return await work(
            overlapCast<unknown, Lock>({ name, mode: "exclusive" }),
          );
        if (isFunction(options)) return await options();
        throw new Error("Missing actual lease callback.");
      } finally {
        held.pop();
      }
    },
  });
  const check = () => {
    if (!held.includes("opensesame.retired-credentials"))
      throw new Error("Missing retained CRED.");
  };
  const port: PhysicalDeviceRecordPort = {
    capture: async () => ({
      check,
      revalidateRoot: async () => check(),
      read: async () => null,
      publish: async () => {
        throw new Error("No detection publication expected.");
      },
      close: async () => {
        check();
        closed = true;
      },
      captureRetiredCredentialInventory: async () => {
        check();
        return retained
          ? [
              {
                tomb: "foreign",
                wire,
                ciphertextDigest: "b".repeat(64),
                physicalName: "foreign-record",
              },
            ]
          : [];
      },
    }),
  };
  configureHost(createTestHost({ locks, physicalDeviceRecords: port }));
  return { held, closed: () => closed, bodyTurns: () => bodyTurns };
}
it("refuses root rotation to an expired foreign retained PIN before changing current root or body", async () => {
  const store = await actualPinVault();
  try {
    const before = store.getSnapshot();
    const header = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
    const body = readSealedFile(PERSONAL_TOMB, BODY_PATH);
    const inventory = await installInventory(true);
    const submitted = { pin: retainedPin };
    const pending = store.protection.rotateCompromisedRoot(submitted);
    submitted.pin = "new caller mutation 48291037";
    await expect(pending).rejects.toThrow("retained");
    expect(store.getSnapshot()).toEqual(before);
    expect(readPlaintextFile(PERSONAL_TOMB, HEADER_PATH)).toBe(header);
    expect(readSealedFile(PERSONAL_TOMB, BODY_PATH)).toEqual(body);
    expect(inventory.closed()).toBe(true);
    expect(inventory.held).toEqual([]);
  } finally {
    store.lock();
  }
});
it("keeps nonmatching PIN rotation compatible while holding CRED through root publication", async () => {
  const store = await actualPinVault();
  try {
    const before = store.getSnapshot().header?.protection?.rootEpoch;
    const inventory = await installInventory(false);
    await store.protection.rotateCompromisedRoot({ pin: retainedPin });
    expect(store.getSnapshot().header?.protection?.rootEpoch).toBe(
      (before ?? 0) + 1,
    );
    expect(inventory.bodyTurns()).toBeGreaterThan(0);
    expect(inventory.closed()).toBe(true);
    expect(inventory.held).toEqual([]);
  } finally {
    store.lock();
  }
});
