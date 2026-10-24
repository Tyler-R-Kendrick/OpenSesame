/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { ensureDeviceIdentityKey } from "@opensesame/app-core/lib/device-identity-key.js";
import {
  kvFileName,
  kvFlush,
  kvForgetFiles,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { configureNativeBrowserOAuthConnector } from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import {
  codebergBackupToken,
  nativeCodebergBackupFixture,
} from "@opensesame/app-core/lib/native-codeberg-backup.test-support.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  createProject,
  setActiveProject,
} from "@opensesame/app-core/lib/projects.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import {
  bindNativeOAuthRuntime,
  nativeCallbackUrl,
} from "../../../modules/connectors.external/native-oauth-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";

declareConnectionsTutorial();

let fixture: Awaited<ReturnType<typeof nativeCodebergBackupFixture>>;
let activation: ReturnType<typeof createActivation>;
let releaseConsent = () => {};
let connectionId: string | undefined;
const parameters = {
  backup_owner: "owned-user",
  backup_repo: "sealed-vault",
  backup_branch: "backup/encrypted",
};
beforeEach(async () => {
  connectionId = undefined;
  fixture = await nativeCodebergBackupFixture({
    authorize: false,
    backupTarget: false,
    redirectUri: nativeCallbackUrl(),
  });
  const test = createTestContext();
  const ctx = {
    ...test.ctx,
    lease: { ...test.ctx.lease, signal: fixture.provider.signal },
    egress: { ...test.ctx.egress, fetch: fixture.transport.fetch },
  };
  activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeApiRuntime(activation);
  bindNativeOAuthRuntime(activation);
  releaseConsent = fixture.bindConsent();
});
afterEach(async () => {
  cleanup();
  releaseConsent();
  activation.dispose();
  await setActiveProject("personal");
  vaultStore.loadActiveProjectScope();
  await fixture.close();
});
function mount() {
  const provider = catalogProvider("codeberg");
  if (!provider) throw new Error("Missing Codeberg catalog row");
  const onFlash = vi.fn();
  const connection = connectionId ? deviceConnection(connectionId) : null;
  return {
    ...render(
      <MemoryRouter>
        <ConnectorSettingsPage
          provider={provider}
          providerId="codeberg"
          connection={connection}
          connections={connection ? [connection] : []}
          loading={false}
          online={true}
          canConfigure={true}
          configureHint=""
          flash={null}
          rememberOffer={null}
          onFlash={onFlash}
          onRememberOffer={() => {}}
          onChanged={() => {}}
        />
      </MemoryRouter>,
    ),
    onFlash,
  };
}
async function configureTarget() {
  const mounted = mount();
  expect(screen.queryByTestId("forge-backup-sync")).toBeNull();
  expect(screen.getByLabelText("Codeberg public client ID")).toHaveProperty(
    "value",
    "",
  );
  fireEvent.change(screen.getByLabelText("Codeberg public client ID"), {
    target: { value: "public-browser-client" },
  });
  expect(fixture.state.exchanges).toBe(0);
  fireEvent.click(screen.getByText("Sign-in options", { selector: "summary" }));
  for (const [label, value] of [
    ["Backup repository owner", parameters.backup_owner],
    ["Backup repository name", parameters.backup_repo],
    ["Backup repository branch", parameters.backup_branch],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Codeberg" }));
  await screen.findByRole("form", { name: "Back up vault" }).catch((error) => {
    expect(mounted.onFlash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    );
    throw error;
  });
  expect(fixture.state.exchanges).toBe(1);
  const created = readDeviceRows().filter(
    (row) =>
      row.providerId === "codeberg" &&
      row.connectionId !== fixture.saved.connectionId,
  );
  expect(created).toHaveLength(1);
  connectionId = created[0]?.connectionId;
  if (!connectionId)
    throw new Error("Expected actual newly configured Codeberg connection");
  expect(readNativeConnector(connectionId)?.configuration.parameters).toEqual(
    parameters,
  );
  return mounted;
}
async function coldReload(pin?: string) {
  cleanup();
  await kvFlush();
  if (pin) {
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    vaultStore.lock();
  }
  kvForgetFiles(new Set(DEVICE_CONNECTOR_KEYS.map(kvFileName)));
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  if (pin) await vaultStore.unlockWithPin(pin);
  return mount();
}
// Each PIN here has more than 50 bits by the PIN KDF's estimate, so it is
// wrapped at the PIN floor (1.2M PBKDF2 rounds). An eight-digit PIN is scaled
// to the 10M ceiling instead, and the six wraps and unwraps this walk makes
// would take the test past its timeout on a loaded runner (pin-kdf.ts).
const SOURCE_PIN = "k7m2q9x4p1";
const TARGET_PIN = "r5t8w3z6n0";
async function targetVault() {
  cleanup();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  const project = await createProject(
    `Codeberg restore ${crypto.randomUUID()}`,
  );
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin(TARGET_PIN);
  const kept = createItem("note", "Keep destination note");
  await vaultStore.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  await coldReload();
  await screen.findByRole("form", { name: "Restore vault backup" });
  return { kept, identity };
}
it("configures, cold reloads, backs up and restores through shared forms into a different PIN vault", async () => {
  await vaultStore.enrollPin(SOURCE_PIN);
  await vaultStore.removePassword();
  const source = createItem("secret", "Mounted Codeberg source");
  source.value = "mounted-codeberg-ciphertext-canary";
  await vaultStore.saveItem(source);
  await configureTarget();
  await coldReload(SOURCE_PIN);
  expect(screen.getByLabelText("Backup repository branch")).toHaveProperty(
    "value",
    parameters.backup_branch,
  );
  fireEvent.submit(await screen.findByRole("form", { name: "Back up vault" }));
  const saved = await screen.findByLabelText("Saved backup ID");
  const id = saved.getAttribute("value") ?? "";
  expect(id).toMatch(/^backups\/.+\.json$/);
  expect(fixture.state.files.get(id)?.bytes.toString()).not.toContain(
    source.value,
  );
  const target = await targetVault();
  fireEvent.change(screen.getByLabelText("Backup name or ID"), {
    target: { value: id },
  });
  fireEvent.change(screen.getByLabelText("Backup password or PIN"), {
    target: { value: SOURCE_PIN },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Restore vault backup" }));
  expect(screen.getByLabelText("Backup password or PIN")).toHaveProperty(
    "value",
    "",
  );
  await screen.findByRole("img", {
    name: "1 items restored from encrypted backup",
  });
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: source.id, value: source.value }),
      expect.objectContaining({ id: target.kept.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb)).keyId,
  ).toBe(target.identity.keyId);
  cleanup();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await expect(vaultStore.unlockWithPin(SOURCE_PIN)).rejects.toThrow();
  await vaultStore.unlockWithPin(TARGET_PIN);
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.id === source.id &&
          item.kind === "secret" &&
          item.value === source.value,
      ),
  ).toBe(true);
  expect(JSON.stringify(readDeviceRows())).not.toContain(codebergBackupToken);
  expect([...fixture.local.files.values()].join()).not.toContain(
    codebergBackupToken,
  );
  expect(
    fixture.state.requests.every(
      (row) =>
        row.url === "/login/oauth/access_token" ||
        row.url === "/api/v1/user" ||
        row.url.startsWith("/api/v1/repos/owned-user/sealed-vault/"),
    ),
  ).toBe(true);
});
it.each(["unmount", "provider", "vault", "replacement"] as const)(
  "withdraws held actual POST on %s without readback or late success",
  async (withdrawal) => {
    await vaultStore.saveItem(createItem("note", "Held Codeberg source"));
    const mounted = await configureTarget();
    mounted.onFlash.mockClear();
    fixture.state.hold = "POST";
    fireEvent.submit(
      await screen.findByRole("form", { name: "Back up vault" }),
    );
    await waitFor(() => expect(fixture.state.held?.method).toBe("POST"));
    await waitFor(() =>
      expect(fixture.state.received.at(-1)).toEqual({
        path: fixture.state.held?.url,
        status: 201,
      }),
    );
    expect(fixture.state.held).toMatchObject({
      closed: false,
      premature: false,
    });
    expect(screen.getByLabelText("Backup name")).toHaveProperty(
      "disabled",
      true,
    );
    expect(mounted.onFlash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    );
    if (withdrawal === "unmount") mounted.unmount();
    if (withdrawal === "provider") fixture.provider.abort();
    if (withdrawal === "vault") vaultStore.lock();
    if (withdrawal === "replacement")
      await configureNativeBrowserOAuthConnector(
        {
          ...fixture.draft,
          parameters: { ...fixture.draft.parameters, ...parameters },
          connectionId,
          revision: readNativeConnector(connectionId ?? "")?.revision,
          displayName: "Changed mounted backup",
        },
        fixture.transport,
      );
    await waitFor(() =>
      expect(fixture.state.held).toMatchObject({
        closed: true,
        premature: true,
      }),
    );
    expect(
      fixture.state.requests.some(
        (row) => row.method === "GET" && row.url.includes("/contents/"),
      ),
    ).toBe(false);
    expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
    expect(mounted.onFlash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
  },
);
