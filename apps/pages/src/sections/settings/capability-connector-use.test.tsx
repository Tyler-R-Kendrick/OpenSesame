/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { forgetDeviceConnectors } from "@opensesame/app-core/lib/device-connectors.js";
import {
  dispatchedFeatureCall,
  resetFeatureUsesForTest,
} from "@opensesame/app-core/lib/feature-request.js";
import { forgeForProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { forgetAllLocalGitRemotes } from "@opensesame/app-core/lib/git-remote-local.js";
import { resetDeliveredModels } from "@opensesame/app-core/lib/hosted-inference.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import { MODEL_PROVIDER_KEY } from "@opensesame/app-core/lib/model-provider.js";
import { runSavedModel } from "@opensesame/app-core/lib/saved-model-agent.js";
import { driveClientSeams } from "@opensesame/app-core/lib/tailnet-sync/client.js";
import { defaultTransport } from "@opensesame/app-core/lib/tailnet-sync/engine.js";
import { stopTailnetSync } from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import {
  boundTailnet,
  resetTailnetConnectorForTest,
  tailnetSyncHeaders,
} from "@opensesame/app-core/lib/tailnet-sync/saved-connector.js";
import {
  pushSavedForgeBackup,
  resetSavedGitBackupForTest,
  savedGitBackupUse,
  vaultBackupSyncSeams,
} from "@opensesame/app-core/lib/vault-backup-sync.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { fakeSupportPageContext } from "@opensesame/support-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStorageConnectors } from "../../modules/backup.cloud-secrets/runtime.js";
import { performGitBackup } from "../../modules/backup.git-remote/runtime.js";
import { startExternalConnectors } from "../../modules/connectors.external/runtime.js";
import { startCertificateConnectors } from "../../modules/enterprise.ca-administration/runtime.js";
import { startIdentityConnectors } from "../../modules/identity.federation/runtime.js";
import { performTailnetSync } from "../../modules/networking.tailnet/runtime.js";
import { loadRemoteAgentModule } from "../../modules/support.remote-ai/runtime.js";
import { startWalletConnectors } from "../../modules/wallet.spending/runtime.js";
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

/** The inference POST `runSavedModel` handed to fetch for this URL. */
function modelSent(providerId: string, url: string): Used {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (String(calls[index]?.[0]) !== url) continue;
    const init = calls[index]?.[1];
    const bodyText = typeof init?.body === "string" ? init.body : "";
    try {
      const fields = JSON.parse(bodyText) as Record<string, string>;
      return { ok: true, fields, secret: headerRecord(init?.headers) };
    } catch {
      return missed(providerId);
    }
  }
  return missed(providerId);
}

function dispatchedUse(providerId: string): Used {
  const call = dispatchedFeatureCall(providerId);
  if (!call) return missed(providerId);
  return { ok: true, fields: call.fields, secret: call.secret };
}

function tailnetSent(provider: Provider): Used {
  const request = performTailnetSync(provider);
  if (!request.ok) return missed(provider.id);
  const headers = tailnetSyncHeaders();
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.fields)) {
    const header = headers[`x-tailnet-${name.replaceAll("_", "-")}`];
    if (header !== value) return missed(provider.id);
    fields[name] = header;
  }
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.secret)) {
    const headerName =
      name === "auth_key"
        ? "x-tailscale-auth-key"
        : `x-tailscale-${name.replaceAll("_", "-")}`;
    if (headers[headerName] !== value) return missed(provider.id);
    secret[name] = headers[headerName] ?? "";
  }
  return { ok: true, fields, secret };
}

/** The request the owning feature sends for one listed connector. */
async function featureUse(provider: Provider): Promise<Used> {
  const id = provider.id;
  if (provider.category === "agent_harnesses") {
    const sent = await runSavedModel(id);
    if (!sent.ok) return missed(id);
    return modelSent(id, sent.url);
  }
  if (provider.category === "networking") return tailnetSent(provider);
  if (provider.category === "backup_recovery") {
    performGitBackup();
    return dispatchedUse(id);
  }
  if (provider.category === "identity") {
    startIdentityConnectors();
    return dispatchedUse(id);
  }
  if (provider.category === "wallet") {
    startWalletConnectors();
    return dispatchedUse(id);
  }
  if (
    provider.category === "cloud_secret_storage" ||
    provider.category === "encryption"
  ) {
    startStorageConnectors();
    return dispatchedUse(id);
  }
  if (provider.category === "certificates") {
    startCertificateConnectors();
    return dispatchedUse(id);
  }
  if (
    provider.category === "password_managers" ||
    provider.category === "local_storage"
  ) {
    startExternalConnectors();
    return dispatchedUse(id);
  }
  return missed(id);
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
    expect(kvGet(MODEL_PROVIDER_KEY) ?? "", provider.id).not.toContain(value);
  }
}

async function expectModels(listed: readonly Provider[]): Promise<void> {
  const harnesses = listed.filter(
    (provider) => provider.category === "agent_harnesses",
  );
  const before = vi.mocked(globalThis.fetch).mock.calls.length;
  const agent = (await loadRemoteAgentModule()).createAgUiAgent();
  expect(agent).not.toBeNull();
  await agent?.run(
    {
      question: "ping",
      history: [],
      context: fakeSupportPageContext(),
    },
    { signal: new AbortController().signal },
  );
  const calls = vi.mocked(globalThis.fetch).mock.calls.slice(before);
  for (const provider of harnesses) {
    const secret = Object.values(expectedSecrets(provider))[0] ?? "";
    const call = calls.find((row) =>
      Object.values(headerRecord(row[1]?.headers)).includes(secret),
    );
    expect(call, provider.id).toBeTruthy();
    const body = typeof call?.[1]?.body === "string" ? call[1].body : "";
    expect(body, provider.id).not.toContain(secret);
    const fields = JSON.parse(body || "{}") as Record<string, string>;
    expect(fields, provider.id).toMatchObject(expectedPublic(provider));
  }
}

async function expectTailnet(listed: readonly Provider[]): Promise<void> {
  performTailnetSync("tailscale");
  const tailscale = listed.find((provider) => provider.id === "tailscale");
  expect(tailscale).toBeTruthy();
  if (!tailscale) return;
  const secret = expectedSecrets(tailscale).auth_key ?? "";
  const headers = tailnetSyncHeaders();
  expect(headers["x-tailscale-auth-key"]).toBe(secret);
  expect(boundTailnet()?.fields).toMatchObject(expectedPublic(tailscale));
  expect(JSON.stringify(boundTailnet()?.fields)).not.toContain(secret);
  driveClientSeams.fetch = vi.fn(async () => {
    return new Response(JSON.stringify({ generation: 1, snapshot: null }), {
      status: 200,
    });
  });
  await defaultTransport.read({
    url: "https://vault.example.ts.net",
    slot: "abcdefgh",
    key: "k".repeat(40),
    label: "drive",
  });
  const init = vi.mocked(driveClientSeams.fetch).mock.calls[0]?.[1];
  const sent = init?.headers as Record<string, string>;
  expect(sent["x-tailscale-auth-key"]).toBe(secret);
  expect(sent.Authorization).toBe(`Bearer ${"k".repeat(40)}`);
  expect(sent["x-tailnet-tailnet"]).toBe(expectedPublic(tailscale).tailnet);
}

async function expectForgePush(
  provider: Provider,
  token: string,
): Promise<void> {
  const forge = forgeForProvider(provider.id);
  if (!forge) return;
  const put = vi.fn(async () => ({ commitSha: "abc" }));
  vaultBackupSyncSeams.sealedEnvelopeJson = () => "{}";
  vaultBackupSyncSeams.putForgeContents = put;
  await pushSavedForgeBackup({
    kind: "git_remote",
    providerId: provider.id,
    connectionId: null,
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
  expect(put, provider.id).toHaveBeenCalledWith(
    expect.objectContaining({ token, forge }),
  );
}

async function expectGitBackups(listed: readonly Provider[]): Promise<void> {
  performGitBackup();
  for (const provider of listed) {
    if (provider.category !== "backup_recovery") continue;
    const used = savedGitBackupUse(provider.id);
    expect(used?.fields, provider.id).toMatchObject(expectedPublic(provider));
    expect(used?.secret, provider.id).toEqual(expectedSecrets(provider));
    const token = used?.secret.token;
    if (!token || !used) continue;
    await expectForgePush(provider, token);
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
    await expectModels(listed);
    await expectTailnet(listed);
    await expectGitBackups(listed);
  });
});
