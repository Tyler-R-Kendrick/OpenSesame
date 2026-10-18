/** Actual Argon matching with physical inventory/lease doubles, not native storage evidence. */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeAll, expect, test } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { deriveRetiredVerifier } from "../retired-credentials/argon-verifier.js";
import { RETIRED_CREDENTIAL_MATCHING_V2 } from "../retired-credentials/records-v2.js";
import { withCurrentCredentialRetiredGuard } from "./current-credential-retired-guard.js";
import type { PhysicalDeviceRecordPort } from "./physical-device-record-port.js";
const previous = host();
afterEach(() => configureHost(previous));
const candidate = "retained credential cannot become ordinary again 7194";
let wire = "";
beforeAll(async () => {
  const salt = new Uint8Array(16).fill(7);
  wire = JSON.stringify({
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
        id: "retained-previous",
        createdAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-02T00:00:00.000Z",
        response: "reject",
        salt: "BwcHBwcHBwcHBwcHBwcHBw==",
        verifier: await deriveRetiredVerifier(candidate, salt),
      },
    ],
    events: [],
  });
  salt.fill(0);
});
function fixture(retained = true, grant = true) {
  let held = false;
  let closed = false;
  let captures = 0;
  const locks = overlapCast<unknown, LockManager>({
    async request<T>(
      name: string,
      _options: { mode: string },
      work: (lock: Lock | null) => Promise<T>,
    ) {
      held = true;
      try {
        return await work(
          grant
            ? overlapCast<unknown, Lock>({ name, mode: "exclusive" })
            : null,
        );
      } finally {
        held = false;
      }
    },
  });
  const check = () => {
    if (!held) throw new Error("Credential lease absent.");
  };
  const port: PhysicalDeviceRecordPort = {
    capture: async () => ({
      check,
      revalidateRoot: async () => check(),
      read: async () => null,
      publish: async () => {
        throw new Error("Caller owns publication.");
      },
      close: async () => {
        check();
        closed = true;
      },
      captureRetiredCredentialInventory: async () => {
        check();
        captures++;
        return retained
          ? [
              {
                tomb: "foreign",
                wire,
                ciphertextDigest: "b".repeat(64),
                physicalName: "native-foreign-retired",
              },
            ]
          : [];
      },
    }),
  };
  configureHost(createTestHost({ locks, physicalDeviceRecords: port }));
  return { held: () => held, closed: () => closed, captures: () => captures };
}
test("expired foreign retained password cannot become current; no publication occurs", async () => {
  const f = fixture();
  let published = false;
  await expect(
    withCurrentCredentialRetiredGuard(
      candidate,
      () => {},
      async () => {
        published = true;
      },
    ),
  ).rejects.toThrow("retained");
  expect(published).toBe(false);
  expect(f.closed()).toBe(true);
  expect(f.held()).toBe(false);
});
test("nonmatching current publication and native cleanup remain inside CRED", async () => {
  const f = fixture();
  let published = false;
  await withCurrentCredentialRetiredGuard(
    "different current credential 49257",
    () => {},
    async (check) => {
      await Promise.resolve();
      check();
      expect(f.held()).toBe(true);
      expect(f.closed()).toBe(false);
      published = true;
    },
  );
  expect(published).toBe(true);
  expect(f.closed()).toBe(true);
  expect(f.held()).toBe(false);
  expect(f.captures()).toBeGreaterThanOrEqual(2);
});
test("missing actual grant refuses before inventory or publication", async () => {
  const f = fixture(false, false);
  await expect(
    withCurrentCredentialRetiredGuard(
      candidate,
      () => {},
      async () => {
        throw new Error("Must not publish");
      },
    ),
  ).rejects.toThrow("not granted");
  expect(f.captures()).toBe(0);
});
test("partial physical installation cannot downgrade to cache absence", async () => {
  configureHost(
    createTestHost({
      physicalVaultAuthentication: {
        bodyFormat: "flat-v1",
        capture: async () => {
          throw new Error("Not expected");
        },
      },
    }),
  );
  await expect(
    withCurrentCredentialRetiredGuard(
      candidate,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow("inventory is required");
});
test("memory-only host retains legacy operation compatibility", async () => {
  configureHost(createTestHost());
  let published = false;
  await withCurrentCredentialRetiredGuard(
    candidate,
    () => {},
    async (check) => {
      check();
      published = true;
    },
  );
  expect(published).toBe(true);
});
