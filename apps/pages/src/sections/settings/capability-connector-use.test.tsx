import { writeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { forgetDeviceConnectors } from "@opensesame/app-core/lib/device-connectors.js";
import { resetFeatureUsesForTest } from "@opensesame/app-core/lib/feature-request.js";
import { forgeForProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { forgetAllLocalGitRemotes } from "@opensesame/app-core/lib/git-remote-local.js";
import { resetDeliveredModels } from "@opensesame/app-core/lib/hosted-inference.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import * as modelProvider from "@opensesame/app-core/lib/model-provider.js";
import { driveClientSeams } from "@opensesame/app-core/lib/tailnet-sync/client.js";
import { defaultTransport } from "@opensesame/app-core/lib/tailnet-sync/engine.js";
import { stopTailnetSync } from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import { resetTailnetConnectorForTest } from "@opensesame/app-core/lib/tailnet-sync/saved-connector.js";
import {
  resetSavedGitBackupForTest,
  savedGitBackupUse,
  syncVaultBackup,
  vaultBackupSyncSeams,
} from "@opensesame/app-core/lib/vault-backup-sync.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
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
import type { TestContext } from "../../modules/test-context.js";
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

type FeatureRuntime = {
  activate(ctx: TestContext["ctx"]): Promise<unknown>;
};

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

async function sentCategory(
  runtime: FeatureRuntime,
  provider: Provider,
): Promise<Used> {
  const t = createTestContext();
  await runtime.activate(t.ctx);
  const call = [...vi.mocked(globalThis.fetch).mock.calls]
    .reverse()
    .find((row) => String(row[0]).includes(`/${provider.id}/`));
  if (!call) return missed(provider.id);
  const bodyText = typeof call[1]?.body === "string" ? call[1].body : "";
  try {
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

async function sentModel(provider: Provider): Promise<Used> {
  const requests = vi.spyOn(modelProvider, "savedModelRequests");
  try {
    await runJob(remoteRuntime, "ag-ui-endpoint");
    const operation = requests.mock.calls
      .flatMap((call) => call[0] ?? [])
      .reverse()
      .find((row) => row.providerId === provider.id);
    if (!operation?.ok) return missed(provider.id);
    const secret = Object.values(expectedSecrets(provider))[0] ?? "";
    if (secret === "") return missed(provider.id);
    const call = [...vi.mocked(globalThis.fetch).mock.calls]
      .reverse()
      .find((row) =>
        Object.values(headerRecord(row[1]?.headers)).includes(secret),
      );
    if (!call) return missed(provider.id);
    const bodyText = typeof call[1]?.body === "string" ? call[1].body : "";
    const fields = JSON.parse(bodyText) as Record<string, string>;
    if (JSON.stringify(fields) !== JSON.stringify(operation.action)) {
      return missed(provider.id);
    }
    const headers = headerRecord(call[1]?.headers);
    for (const value of Object.values(operation.secrets)) {
      if (!Object.values(headers).includes(value)) return missed(provider.id);
    }
    return { ok: true, fields, secret: headers };
  } catch {
    return missed(provider.id);
  } finally {
    requests.mockRestore();
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

async function sentTailnet(provider: Provider): Promise<Used> {
  try {
    await runJob(tailnetRuntime, TAILNET_SYNC_JOB);
    driveClientSeams.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ generation: 1, snapshot: null }), {
          status: 200,
        }),
    );
    await defaultTransport.read({
      url: "https://vault.example.ts.net",
      slot: "abcdefgh",
      key: "k".repeat(40),
      label: "drive",
    });
    const init = vi.mocked(driveClientSeams.fetch).mock.calls[0]?.[1];
    return tailnetUsed(provider, headerRecord(init?.headers));
  } finally {
    stopTailnetSync();
  }
}

async function pushForge(provider: Provider, token: string): Promise<void> {
  const forge = forgeForProvider(provider.id);
  if (!forge || token === "") return;
  const put = vi.fn(async () => ({ commitSha: "abc" }));
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
  await syncVaultBackup(provider.id);
  expect(put, provider.id).toHaveBeenCalledWith(
    expect.objectContaining({ token, forge }),
  );
}

async function sentGit(provider: Provider): Promise<Used> {
  await runJob(gitRuntime, BACKUP_OBSERVER_JOB);
  const used = savedGitBackupUse(provider.id);
  if (!used) return missed(provider.id);
  await pushForge(provider, used.secret.token ?? "");
  return { ok: true, fields: used.fields, secret: used.secret };
}

async function featureUse(provider: Provider): Promise<Used> {
  const category = provider.category;
  if (category === "agent_harnesses") return sentModel(provider);
  if (category === "networking") return sentTailnet(provider);
  if (category === "backup_recovery") return sentGit(provider);
  if (category === "identity") return sentCategory(identityRuntime, provider);
  if (category === "wallet") return sentCategory(walletRuntime, provider);
  if (category === "cloud_secret_storage" || category === "encryption") {
    return sentCategory(storageRuntime, provider);
  }
  if (category === "certificates")
    return sentCategory(certificateRuntime, provider);
  if (category === "password_managers" || category === "local_storage") {
    return sentCategory(externalRuntime, provider);
  }
  return missed(provider.id);
}

async function expectSavedUse(provider: Provider): Promise<void> {
  await saveListed(provider);
  const used = await featureUse(provider);
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

  it("drives each owning feature with the saved fields and attaches the secret only there", async () => {
    const listed = listedProviders();
    for (const provider of listed) {
      expect((await featureUse(provider)).ok, provider.id).toBe(false);
    }
    for (const provider of listed) await expectSavedUse(provider);
  });
});
