import {
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "@opensesame/wallet-consent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost, host } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  pendingConnectorDirectory,
  readConnectorDirectory,
  sealPendingConnectorDirectory,
  syncConnectorDirectory,
} from "../connector-directory.js";
import { kvDelete } from "../kv.js";
import {
  buildLocalPaymentApprovalDigest,
  enrollPaymentApprovalKey,
  localPaymentApprovalIntent,
  resetPaymentApprovalKeys,
} from "../spending-consent.js";
import {
  clearSpendingLeases,
  issueSpendingLease,
  listSpendingLeases,
} from "../spending-leases.js";
import {
  createBudget,
  getSpendingLedger,
  listBudgetRows,
  resetSpendingLedgerCache,
} from "../spending-ledger.js";
import {
  PASSWORD,
  clearVaultSurface,
} from "../vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "../vault/store.js";
import {
  armVercelConnectAuth,
  clearPendingVercelConnectAuth,
  hydrateVercelConnectAuth,
  pendingVercelConnectAuth,
} from "../vercel-connect-session.js";
import { vercelConnectAuth } from "../vercel-connect.js";
import {
  enrollRetiredCredential,
  retiredCredentialOwnerSeams,
} from "./index.js";
import { flushRetiredCredentialTelemetry } from "./telemetry-queue.js";
import { TRAPS_KEY } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

const RETIRED = "old selected staged-authority password";
const previousOwner = retiredCredentialOwnerSeams.isRealOwner;
const previousDirectory = connectorDirectorySeams.listDirectory;
let previousHost: ReturnType<typeof host>;

beforeEach(async () => {
  previousHost = host();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
  vaultStore.lock();
  await flushRetiredCredentialTelemetry();
  await clearVaultSurface();
  vaultStore.loadActiveProjectScope();
  kvDelete(TRAPS_KEY);
  retiredCredentialOwnerSeams.isRealOwner = (tomb) =>
    vaultStore.getSnapshot().status === "unlocked" &&
    !vaultStore.getSnapshot().guest &&
    vaultStore.activeTomb() === tomb;
  await vaultStore.create(PASSWORD);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: PASSWORD,
    retiredPassword: RETIRED,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
});
afterEach(async () => {
  vaultStore.lock();
  await flushRetiredCredentialTelemetry();
  clearPendingVercelConnectAuth();
  clearPendingConnectorDirectory();
  resetSpendingLedgerCache();
  resetPaymentApprovalKeys();
  retiredCredentialOwnerSeams.isRealOwner = previousOwner;
  connectorDirectorySeams.listDirectory = previousDirectory;
  configureHost(previousHost);
});

it("withholds genuinely staged credentials throughout retired entry and never revives them on real recovery", async () => {
  vaultStore.lock();
  await armVercelConnectAuth(
    { token: "owner-staged-token", manageKey: "owner-staged-management-key" },
    null,
  );
  connectorDirectorySeams.listDirectory = async () => ({
    integrations: [],
    connections: [],
  });
  await syncConnectorDirectory({
    endpoint: "https://directory.example.invalid",
    key: "owner-staged-directory-key",
    tomb: null,
  });
  expect(pendingVercelConnectAuth()?.token).toBe("owner-staged-token");
  expect(pendingConnectorDirectory()?.key).toBe("owner-staged-directory-key");
  await unlockWithRetiredCredentialGate(vaultStore, RETIRED);
  await expect(
    hydrateVercelConnectAuth(vaultStore.activeTomb(), { ephemeral: true }),
  ).rejects.toThrow(/authenticate again/);
  await expect(
    sealPendingConnectorDirectory(vaultStore.activeTomb(), { ephemeral: true }),
  ).rejects.toThrow(/authenticate again/);
  await expect(
    armVercelConnectAuth({ token: "forbidden-new-stage" }, null),
  ).rejects.toThrow(/authenticate again/);
  const assertHidden = () =>
    expect({
      connect: pendingVercelConnectAuth(),
      directory: pendingConnectorDirectory(),
    }).toEqual({ connect: null, directory: null });
  assertHidden();
  vaultStore.lock();
  assertHidden();
  await vaultStore.unlock(PASSWORD);
  assertHidden();
  expect(vercelConnectAuth()).toBeNull();
});

it("preserves ordinary guest onboarding and subsequently seals its staging after actual owner recovery", async () => {
  vaultStore.lock();
  await armVercelConnectAuth({ token: "ordinary-staged-token" }, null);
  connectorDirectorySeams.listDirectory = async () => ({
    integrations: [],
    connections: [],
  });
  await syncConnectorDirectory({
    endpoint: "https://directory.example.invalid",
    key: "ordinary-directory-key",
    tomb: null,
  });
  await vaultStore.createGuest();
  await expect(
    hydrateVercelConnectAuth(vaultStore.activeTomb(), { ephemeral: true }),
  ).resolves.toBe(true);
  await expect(
    sealPendingConnectorDirectory(vaultStore.activeTomb(), { ephemeral: true }),
  ).resolves.toBe(true);
  expect(pendingVercelConnectAuth()?.token).toBe("ordinary-staged-token");
  expect(pendingConnectorDirectory()?.key).toBe("ordinary-directory-key");
  vaultStore.lock();
  vaultStore.loadActiveProjectScope();
  await vaultStore.unlock(PASSWORD);
  await expect(hydrateVercelConnectAuth("personal")).resolves.toBe(true);
  await expect(sealPendingConnectorDirectory("personal")).resolves.toBe(true);
  expect(pendingVercelConnectAuth()).toBeNull();
  expect(pendingConnectorDirectory()).toBeNull();
  expect(vercelConnectAuth()?.token).toBe("ordinary-staged-token");
  expect((await readConnectorDirectory("personal"))?.key).toBe(
    "ordinary-directory-key",
  );
});

it("hides owner wallet metadata after synthetic lock and refuses a retained owner ledger after fresh recovery", async () => {
  const budget = createBudget({ name: "Owner private budget", ceiling: 250n });
  const keys = generatePaymentApprovalKeyPair();
  enrollPaymentApprovalKey(keys.publicKeySpki);
  const intent = localPaymentApprovalIntent({ allocationRef: budget.nodeId });
  const digest = await buildLocalPaymentApprovalDigest(intent);
  const lease = await issueSpendingLease({
    allocationRef: budget.nodeId,
    beneficiaryRef: "owner-private-workload",
    grantRef: "owner-grant",
    rootAccountingRef: budget.nodeId,
    intent,
    proof: {
      boundDigest: digest,
      verifiedBytes: signPaymentApprovalDigest(digest, keys.privateKeyPkcs8),
      publicKeySpki: keys.publicKeySpki,
    },
    validFrom: intent.validFrom,
    validUntil: intent.validUntil,
  });
  expect(lease.ok).toBe(true);
  expect(listSpendingLeases()[0]?.beneficiaryRef).toBe(
    "owner-private-workload",
  );
  const retained = getSpendingLedger();
  expect(listBudgetRows()[0]?.label).toBe("Owner private budget");
  vaultStore.lock();
  await unlockWithRetiredCredentialGate(vaultStore, RETIRED);
  expect(listBudgetRows()).toEqual([]);
  expect(listSpendingLeases()).toEqual([]);
  vaultStore.lock();
  expect(listBudgetRows()).toEqual([]);
  expect(listSpendingLeases()).toEqual([]);
  expect(() => clearSpendingLeases()).toThrow();
  expect(() => createBudget({ name: "Unauthorized", ceiling: 1n })).toThrow();
  await vaultStore.unlock(PASSWORD);
  expect(listBudgetRows()[0]?.nodeId).toBe(budget.nodeId);
  expect(listBudgetRows()[0]?.ceiling).toBe(250n);
  expect(listSpendingLeases()[0]?.beneficiaryRef).toBe(
    "owner-private-workload",
  );
  expect(() =>
    retained.transact((tx) =>
      tx.openNode({
        nodeId: "stale-created-root",
        ceiling: 1n,
        strategy: "shared_counter",
      }),
    ),
  ).toThrow();
  expect(listBudgetRows()[0]?.ceiling).toBe(250n);
});
