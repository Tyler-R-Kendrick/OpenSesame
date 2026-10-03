import { writeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { issueCertificate } from "@opensesame/app-core/lib/certs.js";
/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  type Provider,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import { forgetDeviceConnectors } from "@opensesame/app-core/lib/device-connectors.js";
import { resetCategorySendsForTest } from "@opensesame/app-core/lib/feature-request-send.js";
import { resetFeatureUsesForTest } from "@opensesame/app-core/lib/feature-request.js";
import { beginSignIn } from "@opensesame/app-core/lib/federation.js";
import { forgeForProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { forgetAllLocalGitRemotes } from "@opensesame/app-core/lib/git-remote-local.js";
import {
  performInference,
  resetDeliveredModels,
} from "@opensesame/app-core/lib/hosted-inference.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import * as modelProvider from "@opensesame/app-core/lib/model-provider.js";
import { driveClientSeams } from "@opensesame/app-core/lib/tailnet-sync/client.js";
import { writeDriveConfig } from "@opensesame/app-core/lib/tailnet-sync/config.js";
import {
  stopTailnetSync,
  syncTailnetNow,
} from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import { resetTailnetConnectorForTest } from "@opensesame/app-core/lib/tailnet-sync/saved-connector.js";
import {
  resetSavedGitBackupForTest,
  syncVaultBackup,
  vaultBackupSyncSeams,
} from "@opensesame/app-core/lib/vault-backup-sync.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
import { proposeWalletPayment } from "@opensesame/app-core/lib/wallet-agent-broker.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityRuntime as storageRuntime } from "../../modules/backup.cloud-secrets/runtime.js";
import {
  BACKUP_OBSERVER_JOB,
  capabilityRuntime as gitRuntime,
} from "../../modules/backup.git-remote/runtime.js";
import { capabilityRuntime as externalRuntime } from "../../modules/connectors.external/runtime.js";
import { capabilityRuntime as certificateRuntime } from "../../modules/enterprise.ca-administration/runtime.js";
import { capabilityRuntime as identityRuntime } from "../../modules/identity.federation/runtime.js";
import {
  TAILNET_SYNC_JOB,
  capabilityRuntime as tailnetRuntime,
} from "../../modules/networking.tailnet/runtime.js";
import { capabilityRuntime as remoteRuntime } from "../../modules/support.remote-ai/runtime.js";
import { createTestContext } from "../../modules/test-context.js";
import { capabilityRuntime as walletRuntime } from "../../modules/wallet.spending/runtime.js";
import {
  expectedPublic,
  expectedSecrets,
  listedProviders,
  saveListed,
} from "./capability-connector-harness.js";

installDoublePorts();

const originalIdentity = { ...identitySeams };
const originalDriveFetch = driveClientSeams.fetch;
const originalForgePut = vaultBackupSyncSeams.putForgeContents;
const originalEnvelope = vaultBackupSyncSeams.sealedEnvelopeJson;

type Used = {
  ok: boolean;
  fields: Record<string, string>;
  secret: Record<string, string>;
};

type FeatureRuntime = Pick<CapabilityRuntime, "activate">;

function missed(providerId: string): Used {
  return { ok: false, fields: {}, secret: {} };
}

function headerRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

async function runJob(runtime: FeatureRuntime, id: string): Promise<void> {
  const t = createTestContext();
  await runtime.activate(t.ctx);
  const job = t.entries("background-job").find((entry) => entry.id === id);
  job?.start(new AbortController().signal);
}

function fetchBody(body: BodyInit | null | undefined): string {
  if (
    body == null ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return "";
  }
  return body;
}

function sentFetch(provider: Provider): Used {
  const call = [...vi.mocked(globalThis.fetch).mock.calls]
    .reverse()
    .find((row) => String(row[0]).includes(`/${provider.id}/`));
  if (!call) return missed(provider.id);
  const bodyText = fetchBody(call[1]?.body);
  try {
    // SAFETY: this json body is the string record the feature request posted.
    const fields = JSON.parse(bodyText) as Record<string, string>;
    const headers = headerRecord(call[1]?.headers);
    const secret: Record<string, string> = {};
    for (const [name, value] of Object.entries(expectedSecrets(provider))) {
      if (!Object.values(headers).includes(value)) return missed(provider.id);
      secret[name] = value;
    }
    for (const value of Object.values(secret)) {
      if (JSON.stringify(fields).includes(value)) return missed(provider.id);
    }
    return { ok: true, fields, secret };
  } catch {
    return missed(provider.id);
  }
}

function sentModel(provider: Provider): Used {
  const exchange = performInference(provider);
  if (!exchange.ok) return missed(provider.id);
  const call = [...vi.mocked(globalThis.fetch).mock.calls]
    .reverse()
    .find((row) => String(row[0]) === exchange.url);
  if (!call) return missed(provider.id);
  try {
    // SAFETY: this json body is the string record the model request posted.
    const fields = JSON.parse(fetchBody(call[1]?.body)) as Record<
      string,
      string
    >;
    const headers = headerRecord(call[1]?.headers);
    for (const value of Object.values(expectedSecrets(provider))) {
      if (!Object.values(headers).includes(value)) return missed(provider.id);
      if (JSON.stringify(fields).includes(value)) return missed(provider.id);
    }
    return { ok: true, fields, secret: headers };
  } catch {
    return missed(provider.id);
  }
}

function tailnetHeader(name: string, secret: boolean): string {
  const normalized = name.replaceAll("_", "-");
  if (secret && name === "auth_key") return "x-tailscale-auth-key";
  return secret ? `x-tailscale-${normalized}` : `x-tailnet-${normalized}`;
}

function tailnetUsed(
  provider: Provider,
  headers: Record<string, string>,
): Used {
  const fields: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(expectedPublic(provider))) {
    if (headers[tailnetHeader(name, false)] !== value)
      return missed(provider.id);
    fields[name] = value;
  }
  for (const [name, value] of Object.entries(expectedSecrets(provider))) {
    if (headers[tailnetHeader(name, true)] !== value)
      return missed(provider.id);
    secret[name] = value;
  }
  return { ok: true, fields, secret };
}

async function openPersonalVault(): Promise<void> {
  const snap = vaultStore.getSnapshot();
  if (
    snap.status === "unlocked" &&
    !snap.guest &&
    snap.tomb === PERSONAL_TOMB
  ) {
    return;
  }
  if (snap.status === "locked") {
    await vaultStore.unlockWithPin("48291037");
    return;
  }
  await vaultStore.createWithPin("48291037");
}

async function sentTailnet(provider: Provider): Promise<Used> {
  const drive = vi.mocked(driveClientSeams.fetch);
  const before = drive.mock.calls.length;
  try {
    await syncTailnetNow();
    await vi.waitFor(() => {
      expect(drive.mock.calls.length).toBeGreaterThan(before);
    });
    const init = drive.mock.calls.at(-1)?.[1];
    return tailnetUsed(provider, headerRecord(init?.headers));
  } catch {
    return missed(provider.id);
  }
}

async function sentGit(provider: Provider): Promise<Used> {
  const forge = forgeForProvider(provider.id);
  const token = expectedSecrets(provider).token ?? "";
  const put = vi.fn(async (input: { fields?: Record<string, string> }) => {
    void input;
    return { commitSha: "abc" };
  });
  vaultBackupSyncSeams.sealedEnvelopeJson = () => "{}";
  vaultBackupSyncSeams.putForgeContents = put;
  writeLocalBackupTarget({
    kind: "git_remote",
    providerId: provider.id,
    connectionId: `conn-${provider.id}`,
    integrationId: "",
    installationId: "",
    owner: "owner",
    repo: "repo",
    branch: "main",
    enabled: true,
    status: "idle",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 0,
  });
  try {
    await syncVaultBackup(provider.id);
  } catch {
    // A sync without a forge token still posts the saved connector operation.
  }
  const used = sentFetch(provider);
  if (!used.ok || !forge || token === "") return used;
  expect(put, provider.id).toHaveBeenCalledWith(
    expect.objectContaining({
      token,
      forge,
      fields: expect.objectContaining(expectedPublic(provider)),
    }),
  );
  const posted = JSON.stringify(put.mock.calls.at(-1)?.[0].fields ?? {});
  if (posted.includes(token)) return missed(provider.id);
  return used;
}

async function featureUse(provider: Provider): Promise<Used> {
  const category = provider.category;
  if (category === "agent_harnesses") return sentModel(provider);
  if (category === "networking") return sentTailnet(provider);
  if (category === "backup_recovery") return sentGit(provider);
  if (category === "identity") {
    await beginSignIn({
      id: provider.id,
      displayName: provider.id,
      issuer: "",
      accountKind: "account",
    }).catch(() => undefined);
    return sentFetch(provider);
  }
  if (category === "wallet") {
    proposeWalletPayment({
      caller: { principalRef: "principal" },
      nodeId: "node",
      amount: "1",
      destination: "dest",
    });
    return sentFetch(provider);
  }
  if (category === "cloud_secret_storage" || category === "encryption") {
    await syncVaultBackup(provider.id);
    return sentFetch(provider);
  }
  if (category === "certificates") {
    await issueCertificate({ commonName: "connector.example" }).catch(
      () => undefined,
    );
    return sentFetch(provider);
  }
  if (category === "password_managers" || category === "local_storage") {
    await listConnections().catch(() => undefined);
    return sentFetch(provider);
  }
  return missed(provider.id);
}

async function bootFeatures(): Promise<void> {
  await openPersonalVault();
  await writeDriveConfig(PERSONAL_TOMB, {
    url: "https://vault.example.ts.net",
    slot: "abcdefgh",
    key: "k".repeat(40),
    label: "drive",
  });
  driveClientSeams.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ generation: 1, snapshot: null }), {
        status: 200,
      }),
  );
  await runJob(tailnetRuntime, TAILNET_SYNC_JOB);
  await runJob(gitRuntime, BACKUP_OBSERVER_JOB);
  await runJob(remoteRuntime, "ag-ui-endpoint");
  await runJob(identityRuntime, "identity");
  await runJob(walletRuntime, "wallet");
  await runJob(storageRuntime, "storage");
  await runJob(certificateRuntime, "certificates");
  await runJob(externalRuntime, "external");
  await vi.waitFor(() => {
    expect(vi.mocked(driveClientSeams.fetch).mock.calls.length).toBeGreaterThan(
      0,
    );
  });
}

function assertSavedOperation(provider: Provider, used: Used): void {
  const secrets = expectedSecrets(provider);
  expect(used.ok, provider.id).toBe(true);
  expect(used.fields, provider.id).toMatchObject(expectedPublic(provider));
  const packed = JSON.stringify(used.fields);
  const attached = JSON.stringify(used.secret);
  for (const value of Object.values(secrets)) {
    expect(packed, provider.id).not.toContain(value);
    expect(attached, provider.id).toContain(value);
  }
  if (provider.category !== "agent_harnesses") {
    expect(used.secret, provider.id).toEqual(secrets);
  }
  for (const value of Object.values(secrets)) {
    expect(
      kvGet(modelProvider.MODEL_PROVIDER_KEY) ?? "",
      provider.id,
    ).not.toContain(value);
  }
}

describe("capability features use the saved connector", () => {
  beforeEach(async () => {
    identitySeams.hostBase = () => "";
    identitySeams.hostLocalSessionEligible = () => false;
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
    vi.spyOn(vaultStore, "addItems").mockResolvedValue(undefined);
    vi.spyOn(vaultStore, "trashItem").mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    await forgetAllLocalGitRemotes();
    forgetDeviceConnectors();
    resetFeatureUsesForTest();
    resetCategorySendsForTest();
    resetDeliveredModels();
    resetTailnetConnectorForTest();
    resetSavedGitBackupForTest();
    stopTailnetSync();
  });

  afterEach(() => {
    Object.assign(identitySeams, originalIdentity);
    driveClientSeams.fetch = originalDriveFetch;
    vaultBackupSyncSeams.putForgeContents = originalForgePut;
    vaultBackupSyncSeams.sealedEnvelopeJson = originalEnvelope;
    stopTailnetSync();
    vi.restoreAllMocks();
  });

  it("uses a connector saved after the feature is already on", async () => {
    await bootFeatures();
    const listed = listedProviders();
    console.log(`LISTED ${listed.map((provider) => provider.id).join(" ")}`);
    for (const provider of listed) {
      expect((await featureUse(provider)).ok, provider.id).toBe(false);
      await saveListed(provider);
      assertSavedOperation(provider, await featureUse(provider));
    }
  });
});
