/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { forgetDeviceConnectors } from "@opensesame/app-core/lib/device-connectors.js";
import { resetFeatureUsesForTest } from "@opensesame/app-core/lib/feature-request.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";
import { forgeForProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { forgetAllLocalGitRemotes } from "@opensesame/app-core/lib/git-remote-local.js";
import { resetDeliveredModels } from "@opensesame/app-core/lib/hosted-inference.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import {
  MODEL_PROVIDER_KEY,
  savedModelRequest,
} from "@opensesame/app-core/lib/model-provider.js";
import { readDrive } from "@opensesame/app-core/lib/tailnet-sync/client.js";
import { driveClientSeams } from "@opensesame/app-core/lib/tailnet-sync/client.js";
import { stopTailnetSync } from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import {
  boundTailnet,
  resetTailnetConnectorForTest,
  tailnetSyncHeaders,
} from "@opensesame/app-core/lib/tailnet-sync/saved-connector.js";
import {
  resetSavedGitBackupForTest,
  savedGitBackupUse,
  vaultBackupSyncSeams,
} from "@opensesame/app-core/lib/vault-backup-sync.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startStorageConnectors,
  storageOperation,
} from "../../modules/backup.cloud-secrets/runtime.js";
import { performGitBackup } from "../../modules/backup.git-remote/runtime.js";
import {
  externalOperation,
  startExternalConnectors,
} from "../../modules/connectors.external/runtime.js";
import {
  certificateOperation,
  startCertificateConnectors,
} from "../../modules/enterprise.ca-administration/runtime.js";
import {
  identityOperation,
  startIdentityConnectors,
} from "../../modules/identity.federation/runtime.js";
import { performTailnetSync } from "../../modules/networking.tailnet/runtime.js";
import {
  acceptedRemoteModels,
  startAgUiEndpointLoad,
} from "../../modules/support.remote-ai/runtime.js";
import {
  startWalletConnectors,
  walletOperation,
} from "../../modules/wallet.spending/runtime.js";
import {
  expectedPublic,
  expectedSecrets,
  listedProviders,
  saveListed,
} from "./capability-connector-harness.js";

installDoublePorts();

const originalIdentity = { ...identitySeams };
const originalDriveFetch = driveClientSeams.fetch;

type Used = {
  ok: boolean;
  fields: Record<string, string>;
  secret: Record<string, string>;
};

function missed(providerId: string): Used {
  return { ok: false, fields: {}, secret: {} };
}

function fromRequest(request: FeatureRequest): Used {
  if (!request.ok) return missed(request.providerId);
  return { ok: true, fields: request.fields, secret: request.secret };
}

/** The request the owning feature sends for one listed connector. */
function featureUse(provider: Provider): Used {
  const id = provider.id;
  if (provider.category === "agent_harnesses") {
    const call = savedModelRequest(id);
    if (!call.ok) return missed(id);
    return { ok: true, fields: call.body, secret: call.headers };
  }
  if (provider.category === "networking")
    return fromRequest(performTailnetSync(provider));
  if (provider.category === "backup_recovery") {
    return fromRequest(
      performGitBackup().find((row) => row.providerId === id) ?? {
        ok: false,
        providerId: id,
      },
    );
  }
  if (provider.category === "identity") {
    startIdentityConnectors();
    return fromRequest(identityOperation(id));
  }
  if (provider.category === "wallet") {
    startWalletConnectors();
    return fromRequest(walletOperation(id));
  }
  if (
    provider.category === "cloud_secret_storage" ||
    provider.category === "encryption"
  ) {
    startStorageConnectors();
    return fromRequest(storageOperation(id));
  }
  if (provider.category === "certificates") {
    startCertificateConnectors();
    return fromRequest(certificateOperation(id));
  }
  if (
    provider.category === "password_managers" ||
    provider.category === "local_storage"
  ) {
    startExternalConnectors();
    return fromRequest(externalOperation(id));
  }
  return missed(id);
}

async function expectSavedUse(provider: Provider): Promise<void> {
  await saveListed(provider);
  const used = featureUse(provider);
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

function expectModels(listed: readonly Provider[]): void {
  const harnesses = listed.filter(
    (provider) => provider.category === "agent_harnesses",
  );
  startAgUiEndpointLoad(new AbortController().signal);
  expect(
    acceptedRemoteModels()
      .map((row) => row.providerId)
      .sort(),
  ).toEqual(harnesses.map((provider) => provider.id).sort());
  const anthropic = acceptedRemoteModels().find(
    (row) => row.providerId === "anthropic",
  );
  expect(anthropic?.ok).toBe(true);
  if (!anthropic?.ok) return;
  expect(JSON.stringify(anthropic.body)).not.toContain(
    anthropic.headers.authorization ?? "",
  );
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
  await readDrive({
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

function expectGitBackups(listed: readonly Provider[]): void {
  performGitBackup();
  for (const provider of listed) {
    if (provider.category !== "backup_recovery") continue;
    const used = savedGitBackupUse(provider.id);
    expect(used?.fields, provider.id).toMatchObject(expectedPublic(provider));
    expect(used?.secret, provider.id).toEqual(expectedSecrets(provider));
    const forge = forgeForProvider(provider.id);
    const token = used?.secret.token;
    if (!forge || !token || !used) continue;
    const creds = vaultBackupSyncSeams.resolveForgeCredentials({
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
    expect(creds?.token, provider.id).toBe(token);
    expect(creds?.forge, provider.id).toBe(forge);
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
    stopTailnetSync();
    vi.restoreAllMocks();
  });

  it("drives each owning feature with the saved fields and attaches the secret only there", async () => {
    const listed = listedProviders();
    for (const provider of listed) {
      expect(featureUse(provider).ok, provider.id).toBe(false);
    }
    for (const provider of listed) await expectSavedUse(provider);
    expectModels(listed);
    await expectTailnet(listed);
    expectGitBackups(listed);
  });
});
