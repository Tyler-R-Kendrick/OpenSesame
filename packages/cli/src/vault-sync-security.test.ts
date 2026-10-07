import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requiresFreshOwnerAuthentication } from "@opensesame/app-core/lib/decoy-session.js";
import {
  listAdditionalIdpRegistrations,
  registerIdp,
} from "@opensesame/app-core/lib/idp-registry.js";
import {
  GUEST_PROFILE_ID,
  activeOrgProfileId,
  setActiveOrgProfileId,
} from "@opensesame/app-core/lib/orgs.js";
import {
  type RetiredCredentialResponse,
  enrollRetiredCredential,
  refreshRetiredCredentialStatus,
} from "@opensesame/app-core/lib/retired-credentials/index.js";
import type { DriveTransport } from "@opensesame/app-core/lib/tailnet-sync/engine.js";
import { formatPairingCode } from "@opensesame/app-core/lib/tailnet-sync/pairing.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault, unlockLocalVault } from "./vault-session.js";
import { syncVault } from "./vault-sync.js";

const CURRENT = "correct horse battery staple";
const RETIRED = "retired sync owner password 7391";
const CODE = formatPairingCode({
  url: "https://desk.tail4c2e.ts.net",
  slot: "5b1c2d3e-0f4a-4b6c-8d9e-0a1b2c3d4e5f",
  key: "Qm9ndXMtZXZpZGVuY2Uta2V5LW5vdC1hLXJlYWwtb25l",
  label: "Desk",
});
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "os-retired-sync-"));
  const store = await openLocalVault(directory);
  await store.create(CURRENT);
  await store.addItems([createItem("note", "Owner-only sync fixture")]);
  await store.flushPendingWrites();
  await releaseVaultKv();
});
afterEach(async () => {
  await releaseVaultKv();
  await rm(directory, { recursive: true, force: true });
});

const responses: RetiredCredentialResponse[] = ["reject", "synthetic_decoy"];
it.each(responses)(
  "refuses a %s retired credential before injected drive I/O",
  async (response) => {
    const owner = await openLocalVault(directory);
    await unlockLocalVault(owner, CURRENT);
    const tomb = owner.activeTomb();
    await enrollRetiredCredential({
      tomb,
      currentPassword: CURRENT,
      retiredPassword: RETIRED,
      response,
      acknowledgePasswordVerifierRisk: true,
    });
    await releaseVaultKv();
    let reads = 0;
    let writes = 0;
    const transport: DriveTransport = {
      read: async () => {
        reads += 1;
        return { generation: 0, snapshot: null };
      },
      write: async () => {
        writes += 1;
        return { ok: true, generation: 1 };
      },
    };
    await expect(
      syncVault(
        { name: "vault-sync", code: CODE, flags: { json: true } },
        { stateDir: directory, readPassword: async () => RETIRED, transport },
      ),
    ).rejects.toThrow();
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
    const reopened = await openLocalVault(directory);
    await unlockLocalVault(reopened, CURRENT);
    expect(reopened.getSnapshot().items.map((item) => item.name)).toContain(
      "Owner-only sync fixture",
    );
    expect(
      (await refreshRetiredCredentialStatus(tomb)).events.some(
        (event) => event.type === "retired_credential_observed",
      ),
    ).toBe(true);
  },
  30_000,
);

it("rejects a stale injected read after a real-to-synthetic transition without writing", async () => {
  let writes = 0;
  let syntheticStarted = false;
  const transport: DriveTransport = {
    read: async () => {
      const { vaultStore } = await import(
        "@opensesame/app-core/lib/vault/store.js"
      );
      vaultStore.lock();
      await vaultStore.createGuest({
        decoy: true,
        isolated: true,
        resume: false,
      });
      syntheticStarted = vaultStore.getSnapshot().decoy === true;
      return { generation: 0, snapshot: null };
    },
    write: async () => {
      writes += 1;
      return { ok: true, generation: 1 };
    },
  };
  await expect(
    syncVault(
      { name: "vault-sync", code: CODE, flags: { json: true } },
      { stateDir: directory, readPassword: async () => CURRENT, transport },
    ),
  ).rejects.toThrow();
  expect(syntheticStarted).toBe(true);
  expect(writes).toBe(0);
  const reopened = await openLocalVault(directory);
  await unlockLocalVault(reopened, CURRENT);
  expect(reopened.getSnapshot().items.map((item) => item.name)).toContain(
    "Owner-only sync fixture",
  );
}, 30_000);

it("keeps owner caches hidden after synthetic lock until actual fresh owner unlock", async () => {
  const owner = await openLocalVault(directory);
  await unlockLocalVault(owner, CURRENT);
  registerIdp({
    id: "owner-provider",
    issuer: "https://owner.example.invalid",
    label: "Owner provider",
    kind: "byo",
    registeredAt: "2026-10-06T00:00:00Z",
  });
  setActiveOrgProfileId("org:owner-only");
  await vfsFlush();
  await enrollRetiredCredential({
    tomb: owner.activeTomb(),
    currentPassword: CURRENT,
    retiredPassword: RETIRED,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  owner.lock();
  await unlockLocalVault(owner, RETIRED);
  owner.lock();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  expect(listAdditionalIdpRegistrations()).toEqual([]);
  expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
  const reopening = await openLocalVault(directory);
  await expect(
    unlockLocalVault(reopening, "wrong owner fixture"),
  ).rejects.toThrow();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  expect(listAdditionalIdpRegistrations()).toEqual([]);
  await unlockLocalVault(reopening, CURRENT);
  expect(requiresFreshOwnerAuthentication()).toBe(false);
  expect(
    listAdditionalIdpRegistrations().map((provider) => provider.id),
  ).toContain("owner-provider");
  expect(activeOrgProfileId()).toBe("org:owner-only");
}, 30_000);
