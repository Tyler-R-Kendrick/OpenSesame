import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectPlan } from "./connect-plan.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { kvFileName, kvFlush, kvForgetFiles, kvHydrate } from "./kv.js";
import { nativeCatalogResources } from "./native-api-catalog-resources.js";
import {
  configureNativeApiConnector,
  invokeNativeApiConnector,
} from "./native-api-connectors.js";
import { readNativeConnector } from "./native-connector-store.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import { nativeGitlabBackupTarget } from "./native-gitlab-backup-target.js";
import { openNativeGitlabBackup } from "./native-gitlab-backup.js";
import {
  gitlabBackupTarget,
  gitlabBackupToken,
  nativeGitlabBackupFixture,
} from "./native-gitlab-backup.test-support.js";
import {
  type SecretBackendBackupHandle,
  backUpVaultToSecretBackend,
} from "./secret-backends/backup-transfer.js";
import { vaultStore } from "./vault/store.js";
let fixture: Awaited<ReturnType<typeof nativeGitlabBackupFixture>>;
const handles: SecretBackendBackupHandle[] = [];
const tasks: Promise<unknown>[] = [];
beforeEach(async () => {
  fixture = await nativeGitlabBackupFixture();
});
afterEach(async () => {
  for (const handle of handles.splice(0))
    await handle.backend.disconnect(handle.session);
  await Promise.allSettled(tasks.splice(0));
  await fixture.close();
  vi.restoreAllMocks();
});
async function open() {
  const handle = await openNativeGitlabBackup(
    fixture.saved.connectionId,
    gitlabBackupTarget,
    {
      vault: vaultStore,
      transport: fixture.transport,
      signal: fixture.action.signal,
    },
  );
  handles.push(handle);
  return handle;
}
it("cold-reopens the exact target and original sealed key without exposing it in public records or durable local storage", async () => {
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  const saved = readNativeConnector(fixture.saved.connectionId);
  expect(saved?.status).toBe("connected");
  await vaultStore.flushPendingWrites();
  await kvFlush();
  vaultStore.lock();
  kvForgetFiles(new Set(DEVICE_CONNECTOR_KEYS.map(kvFileName)));
  await vaultStore.unlockWithPin("83619472");
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(
    readNativeConnector(fixture.saved.connectionId)?.configuration,
  ).toEqual(saved?.configuration);
  expect(JSON.stringify(readDeviceRows())).not.toContain(gitlabBackupToken);
  expect([...fixture.local.files.values()].join()).not.toContain(
    gitlabBackupToken,
  );
  await vaultStore.saveItem(createItem("note", "Cold GitLab source"));
  const handle = await open();
  await expect(
    backUpVaultToSecretBackend(handle, "Cold backup"),
  ).resolves.toHaveProperty("id");
});
it("preserves the account-only /user verification and membership-project read with both fields explicitly optional", async () => {
  const method = connectPlan("gitlab")?.methods.find(
    (entry) => entry.kind === "api-key",
  );
  if (method?.kind !== "api-key") throw new Error("Missing API-key method");
  expect(method.preset?.templateParams).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "backup_project",
        required: false,
        secret: false,
      }),
      expect.objectContaining({
        name: "backup_branch",
        required: false,
        secret: false,
      }),
    ]),
  );
  const start = fixture.state.requests.length;
  const view = await configureNativeApiConnector(
    { ...fixture.draft, parameters: {} },
    fixture.transport,
  );
  expect(fixture.state.requests.slice(start).map((row) => row.url)).toEqual([
    "/api/v4/user",
  ]);
  expect(nativeGitlabBackupTarget(view.configuration.parameters)).toBeNull();
  await expect(
    invokeNativeApiConnector(
      view.connectionId,
      "provider.read",
      {},
      fixture.transport,
    ),
  ).resolves.toHaveProperty("label", "owned-user");
  const resource = nativeCatalogResources.find(
    (row) => row.providerId === "gitlab",
  );
  if (!resource) throw new Error("Missing project resource");
  await expect(
    resource.read(view.connectionId, {}, fixture.transport),
  ).resolves.toMatchObject({ items: [{ id: "842", label: "Sealed vault" }] });
  await expect(
    openNativeGitlabBackup(view.connectionId, gitlabBackupTarget, {
      vault: vaultStore,
      transport: fixture.transport,
    }),
  ).rejects.toThrow();
});
it("keeps an existing verified revision stable under a rendered-view caller fence", async () => {
  const saved = readNativeConnector(fixture.saved.connectionId);
  if (!saved) throw new Error("Missing saved connection");
  const handle = await openNativeGitlabBackup(
    saved.connectionId,
    gitlabBackupTarget,
    {
      vault: vaultStore,
      transport: fixture.transport,
      assertCurrent: () => {
        expect(readNativeConnector(saved.connectionId)?.revision).toBe(
          saved.revision,
        );
      },
    },
  );
  handles.push(handle);
  await expect(
    backUpVaultToSecretBackend(handle, "Rendered backup"),
  ).resolves.toHaveProperty("id");
});
it("does not substitute an unconfigured project or branch before any protected request", async () => {
  const start = fixture.state.requests.length;
  await expect(
    openNativeGitlabBackup(
      fixture.saved.connectionId,
      { ...gitlabBackupTarget, project: "foreign/project" },
      { vault: vaultStore, transport: fixture.transport },
    ),
  ).rejects.toThrow();
  expect(fixture.state.requests).toHaveLength(start);
});
it("invalidates the original handle after a same-key configuration edit", async () => {
  const handle = await open();
  const changed = await configureNativeApiConnector(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: readNativeConnector(fixture.saved.connectionId)?.revision,
      displayName: "Edited destination owner",
    },
    fixture.transport,
  );
  expect(changed.configuration.fingerprint).toBe(
    fixture.saved.configuration.fingerprint,
  );
  expect(handle.session.signal?.aborted).toBe(true);
  const count = fixture.state.requests.length;
  await expect(
    handle.backend.getItem("opensesame-vault.backup.json", handle.session),
  ).rejects.toThrow();
  expect(fixture.state.requests).toHaveLength(count);
});
it.each(["POST", "PUT"])(
  "physically drains a successful held %s response on caller withdrawal and makes no follow-on requests",
  async (method) => {
    const handle = await open();
    const backup = await backUpVaultToSecretBackend(handle, "Initial backup");
    const prior = await handle.backend.getItem(backup.id, handle.session);
    fixture.state.hold = method;
    const update = handle.backend.updateItem;
    if (!update) throw new Error("Missing CAS update");
    const pending =
      method === "POST"
        ? backUpVaultToSecretBackend(handle, "Held backup")
        : update(
            backup.id,
            {
              name: "Held update",
              kind: "note",
              notes: prior.notes,
              secret: "",
              fields: { last_commit_id: prior.fields?.last_commit_id ?? "" },
            },
            handle.session,
          );
    tasks.push(pending);
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(() => fixture.state.held).toBeDefined();
    const held = fixture.state.held;
    if (!held) throw new Error("Missing held response");
    await expect
      .poll(() =>
        fixture.state.received.some(
          (row) =>
            row.path === held.url &&
            row.status === (method === "POST" ? 201 : 200),
        ),
      )
      .toBe(true);
    expect(held.premature).toBe(false);
    fixture.action.abort();
    await rejected;
    await expect.poll(() => held.premature).toBe(true);
    const count = fixture.state.requests.length;
    await expect(
      backUpVaultToSecretBackend(handle, "After withdrawal"),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
  },
);
it.each(["project", "archived", "readonly", "ref"])(
  "refuses a provider's %s target proof without changing the saved connection",
  async (corrupt) => {
    const saved = readNativeConnector(fixture.saved.connectionId);
    fixture.state.corrupt = corrupt;
    await expect(
      configureNativeApiConnector(
        {
          ...fixture.draft,
          connectionId: fixture.saved.connectionId,
          revision: saved?.revision,
        },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(readNativeConnector(fixture.saved.connectionId)).toEqual(saved);
  },
);
it("rejects a different actual account before acquiring repository authority", async () => {
  fixture.state.corrupt = "account";
  const count = fixture.state.requests.length;
  await expect(open()).rejects.toMatchObject({ code: "stale" });
  expect(fixture.state.requests.slice(count).map((row) => row.url)).toEqual([
    "/api/v4/user",
  ]);
});
it("cancels the initial account probe on saved-configuration replacement", async () => {
  fixture.state.hold = "GET";
  fixture.state.holdPath = "/api/v4/user";
  const pending = open();
  tasks.push(pending);
  const rejected = expect(pending).rejects.toThrow();
  await expect.poll(() => fixture.state.held).toBeDefined();
  fixture.state.hold = "";
  await configureNativeApiConnector(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: readNativeConnector(fixture.saved.connectionId)?.revision,
      displayName: "Replaced during account proof",
    },
    fixture.transport,
  );
  await rejected;
  await expect.poll(() => fixture.state.held?.premature).toBe(true);
});
it("captures the original native route once and never sends credentials to a replacement activation", async () => {
  let captures = 0;
  const uncaptured = vi.fn(async () => {
    throw new Error("Uncaptured origin forbidden");
  });
  const release = bindNativeProviderTransport({
    ...fixture.transport,
    fetch: uncaptured,
    capture: () => {
      captures++;
      return fixture.transport;
    },
  });
  const replacement = vi.fn(async () => {
    throw new Error("Replacement route forbidden");
  });
  let releaseReplacement = () => {};
  try {
    const handle = await openNativeGitlabBackup(
      fixture.saved.connectionId,
      gitlabBackupTarget,
      { vault: vaultStore, signal: fixture.action.signal },
    );
    handles.push(handle);
    fixture.state.hold = "GET";
    const pending = handle.backend.getItem(
      "opensesame-vault.backup.json",
      handle.session,
    );
    tasks.push(pending);
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(() => fixture.state.held).toBeDefined();
    releaseReplacement = bindNativeProviderTransport({
      ...fixture.transport,
      fetch: replacement,
    });
    fixture.provider.abort();
    await rejected;
    await expect.poll(() => fixture.state.held?.premature).toBe(true);
    await expect(
      handle.backend.getItem("opensesame-vault.backup.json", handle.session),
    ).rejects.toThrow();
    expect(captures).toBe(1);
    expect(uncaptured).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  } finally {
    releaseReplacement();
    release();
  }
});
type InvalidTargets = Record<string, string>[];
const invalid: InvalidTargets = [
  { backup_project: "owned/project" },
  { backup_project: "owned/project", backup_branch: "../bad" },
  { backup_project: "https://foreign.example/project", backup_branch: "main" },
  { endpoint: "https://foreign.example" },
];
it.each(invalid)(
  "refuses invalid target before HTTP: %o",
  async (parameters) => {
    const count = fixture.state.requests.length;
    await expect(
      configureNativeApiConnector(
        { ...fixture.draft, parameters },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
  },
);

it("does not mistake read-only API access for a successful backup or expose a reflected provider error", async () => {
  const handle = await open();
  fixture.state.writeDeny = 403;
  const write = backUpVaultToSecretBackend(handle, "Read-only token backup");
  await expect(write).rejects.toMatchObject({ code: "response" });
  await expect(write).rejects.not.toThrow(gitlabBackupToken);
  expect(fixture.state.files.size).toBe(0);
  expect(readNativeConnector(fixture.saved.connectionId)?.status).toBe(
    "connected",
  );
});
it("sanitizes credential-reflecting target parser failures", async () => {
  fixture.state.corrupt = "reflection";
  const pending = configureNativeApiConnector(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: readNativeConnector(fixture.saved.connectionId)?.revision,
    },
    fixture.transport,
  );
  await expect(pending).rejects.toMatchObject({ code: "response" });
  await expect(pending).rejects.not.toThrow(gitlabBackupToken);
});
it("invalidates a refused original credential during the initial account probe", async () => {
  fixture.state.deny = 401;
  await expect(open()).rejects.toMatchObject({ code: "authorization" });
  expect(readNativeConnector(fixture.saved.connectionId)?.status).not.toBe(
    "connected",
  );
});
