import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { kvFileName, kvFlush, kvForgetFiles, kvHydrate } from "./kv.js";
import {
  configureNativeBrowserOAuthConnector,
  verifyNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import { nativeCodebergBackupTarget } from "./native-codeberg-backup-target.js";
import { openNativeCodebergBackup } from "./native-codeberg-backup.js";
import {
  codebergBackupTarget,
  codebergBackupToken,
  nativeCodebergBackupFixture,
} from "./native-codeberg-backup.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import {
  type SecretBackendBackupHandle,
  backUpVaultToSecretBackend,
} from "./secret-backends/backup-transfer.js";
import { vaultStore } from "./vault/store.js";
let fixture: Awaited<ReturnType<typeof nativeCodebergBackupFixture>>;
const handles: SecretBackendBackupHandle[] = [];
const tasks: Promise<unknown>[] = [];
beforeEach(async () => {
  fixture = await nativeCodebergBackupFixture();
});
afterEach(async () => {
  for (const handle of handles.splice(0))
    await handle.backend.disconnect(handle.session);
  await Promise.allSettled(tasks.splice(0));
  await fixture.close();
  vi.restoreAllMocks();
});
async function open() {
  const handle = await openNativeCodebergBackup(
    fixture.saved.connectionId,
    codebergBackupTarget,
    {
      vault: vaultStore,
      transport: fixture.transport,
      signal: fixture.action.signal,
    },
  );
  handles.push(handle);
  return handle;
}
it("cold-reopens an actual PKCE grant with its exact saved target and independently retained credential custody", async () => {
  const saved = readNativeConnector(fixture.saved.connectionId);
  expect(saved?.status).toBe("connected");
  expect(saved?.configuration.parameters).toEqual({
    backup_owner: "owned-user",
    backup_repo: "sealed-vault",
    backup_branch: "backup/encrypted",
  });
  await kvFlush();
  kvForgetFiles(new Set(DEVICE_CONNECTOR_KEYS.map(kvFileName)));
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(
    readNativeConnector(fixture.saved.connectionId)?.configuration,
  ).toEqual(saved?.configuration);
  expect(JSON.stringify(readDeviceRows())).not.toContain(codebergBackupToken);
  expect([...fixture.local.files.values()].join()).not.toContain(
    codebergBackupToken,
  );
  await vaultStore.saveItem(createItem("note", "Cold Codeberg source"));
  const handle = await open();
  await expect(
    backUpVaultToSecretBackend(handle, "Cold backup"),
  ).resolves.toHaveProperty("id");
  expect(fixture.state.exchanges).toBe(1);
  expect(fixture.state.refreshes).toBe(0);
});
it("keeps an already verified account revision stable under the actual rendered-view caller fence", async () => {
  const saved = readNativeConnector(fixture.saved.connectionId);
  if (!saved) throw new Error("Expected real verified connector");
  const handle = await openNativeCodebergBackup(
    saved.connectionId,
    codebergBackupTarget,
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
    backUpVaultToSecretBackend(handle, "Rendered owner backup"),
  ).resolves.toHaveProperty("id");
  expect(readNativeConnector(saved.connectionId)?.revision).toBe(
    saved.revision,
  );
});
it("refreshes an expired real grant on the same captured route before opening, without adopting or exposing a fake API key", async () => {
  const initial = loadNativeConnectorRecord(fixture.saved.connectionId);
  const expiry = initial?.privateState.grants.user?.expiresAt;
  if (!expiry) throw new Error("Expected actual issued expiry");
  vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
  const handle = await open();
  await expect(
    backUpVaultToSecretBackend(handle, "Refreshed backup"),
  ).resolves.toHaveProperty("id");
  const rotated = loadNativeConnectorRecord(fixture.saved.connectionId);
  expect(fixture.state.refreshes).toBe(1);
  expect(rotated?.privateState.credentials).toEqual({});
  expect(rotated?.privateState.recovery).toEqual([]);
  expect(rotated?.privateState.grants.user?.accessToken).toBe(
    fixture.state.token,
  );
  expect(rotated?.privateState.grants.user?.refreshToken).toBe(
    fixture.state.refresh,
  );
  expect(rotated?.configuration.requestedScopes.user).toEqual([]);
});
it("does not substitute a passed target for the configured target or perform protected HTTP for mismatches", async () => {
  const count = fixture.state.requests.length;
  await expect(
    openNativeCodebergBackup(
      fixture.saved.connectionId,
      { ...codebergBackupTarget, repo: "foreign" },
      { vault: vaultStore, transport: fixture.transport },
    ),
  ).rejects.toThrow();
  expect(fixture.state.requests).toHaveLength(count);
});
it("ends old handles on a target-only edit even when the OAuth account fingerprint remains unchanged", async () => {
  const handle = await open();
  const old = readNativeConnector(fixture.saved.connectionId);
  const changed = await configureNativeBrowserOAuthConnector(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: old?.revision,
      parameters: { ...fixture.draft.parameters, backup_repo: "other" },
    },
    fixture.transport,
  );
  expect(changed.configuration.fingerprint).toBe(
    old?.configuration.fingerprint,
  );
  expect(handle.session.signal?.aborted).toBe(true);
  const count = fixture.state.requests.length;
  await expect(
    handle.backend.getItem("opensesame-vault.backup.json", handle.session),
  ).rejects.toThrow();
  expect(fixture.state.requests).toHaveLength(count);
  expect(
    nativeCodebergBackupTarget(changed.configuration.parameters)?.repo,
  ).toBe("other");
});
it.each(["POST", "PUT"])(
  "physically drains held %s on caller withdrawal and makes no later provider requests",
  async (method) => {
    const handle = await open();
    const backup = await backUpVaultToSecretBackend(
      handle,
      "Initial encrypted backup",
    );
    const current = await handle.backend.getItem(backup.id, handle.session);
    fixture.state.hold = method;
    const update = handle.backend.updateItem;
    if (!update) throw new Error("Missing Codeberg CAS update");
    const pending =
      method === "POST"
        ? backUpVaultToSecretBackend(handle, "Held create")
        : update(
            backup.id,
            {
              name: "Held update",
              kind: "note",
              notes: current.notes,
              secret: "",
              fields: { sha: current.fields?.sha ?? "" },
            },
            handle.session,
          );
    tasks.push(pending);
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(() => fixture.state.held).toBeDefined();
    fixture.action.abort();
    await rejected;
    await expect.poll(() => fixture.state.held?.premature).toBe(true);
    const count = fixture.state.requests.length;
    await expect(
      backUpVaultToSecretBackend(handle, "After withdrawal"),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
  },
);
it("refuses an absent branch while opening instead of returning a usable backup handle", async () => {
  const record = readNativeConnector(fixture.saved.connectionId);
  await configureNativeBrowserOAuthConnector(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: record?.revision,
      parameters: { ...fixture.draft.parameters, backup_branch: "missing" },
    },
    fixture.transport,
  );
  await verifyNativeBrowserOAuthConnector(
    fixture.saved.connectionId,
    fixture.transport,
  );
  await expect(
    openNativeCodebergBackup(
      fixture.saved.connectionId,
      { ...codebergBackupTarget, branch: "missing" },
      { vault: vaultStore, transport: fixture.transport },
    ),
  ).rejects.toMatchObject({ code: "not-found" });
});
it("physically drains the initial account probe when its exact target changes", async () => {
  fixture.state.hold = "GET";
  const pending = open();
  tasks.push(pending);
  const rejected = expect(pending).rejects.toThrow();
  await expect.poll(() => fixture.state.held).toBeDefined();
  const record = readNativeConnector(fixture.saved.connectionId);
  await configureNativeBrowserOAuthConnector(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: record?.revision,
      parameters: {
        ...fixture.draft.parameters,
        backup_repo: "changed-during-probe",
      },
    },
    fixture.transport,
  );
  await rejected;
  await expect.poll(() => fixture.state.held?.premature).toBe(true);
});
it("refuses a different actual account before obtaining repository authority", async () => {
  fixture.state.corrupt = "account";
  const start = fixture.state.requests.length;
  await expect(open()).rejects.toMatchObject({ code: "stale" });
  expect(fixture.state.requests.slice(start).map((row) => row.url)).toEqual([
    "/api/v1/user",
  ]);
});
it("captures the authorized native route once and never adopts a replacement during held I/O", async () => {
  let captures = 0;
  const uncaptured = vi.fn(async () => {
    throw new Error("Uncaptured origin request forbidden");
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
    throw new Error("Replacement route must not receive credentials");
  });
  let releaseReplacement = () => {};
  try {
    const handle = await openNativeCodebergBackup(
      fixture.saved.connectionId,
      codebergBackupTarget,
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
    const count = fixture.state.requests.length;
    await expect(
      handle.backend.getItem("opensesame-vault.backup.json", handle.session),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
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
  { backup_owner: "owned-user" },
  {
    backup_owner: "owned-user",
    backup_repo: "sealed-vault",
    backup_branch: "../bad",
  },
  { endpoint: "https://foreign.example" },
];
it.each(invalid)(
  "refuses invalid target input before HTTP: %o",
  async (parameters) => {
    const count = fixture.state.requests.length;
    await expect(
      configureNativeBrowserOAuthConnector(
        {
          ...fixture.draft,
          parameters: { client_id: "public-browser-client", ...parameters },
        },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
  },
);
it("preserves account-only configurations without enabling a fabricated backup target", async () => {
  const view = await configureNativeBrowserOAuthConnector(
    { ...fixture.draft, parameters: { client_id: "public-browser-client" } },
    fixture.transport,
  );
  expect(nativeCodebergBackupTarget(view.configuration.parameters)).toBeNull();
  await expect(
    openNativeCodebergBackup(view.connectionId, codebergBackupTarget, {
      vault: vaultStore,
      transport: fixture.transport,
    }),
  ).rejects.toThrow();
});
