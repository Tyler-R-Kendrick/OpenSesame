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
import {
  githubBackupToken,
  nativeGithubBackupFixture,
} from "@opensesame/app-core/lib/native-github-backup.test-support.js";
import { configureNativeGithubPersonal } from "@opensesame/app-core/lib/native-github-personal.js";
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
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";

declareConnectionsTutorial();

let fixture: Awaited<ReturnType<typeof nativeGithubBackupFixture>>;
let activation: ReturnType<typeof createActivation>;
const parameters = {
  backup_owner: "octocat",
  backup_repo: "sealed-vault",
  backup_branch: "backup/encrypted",
};
beforeEach(async () => {
  fixture = await nativeGithubBackupFixture();
  const test = createTestContext();
  const ctx = {
    ...test.ctx,
    lease: { ...test.ctx.lease, signal: fixture.provider.signal },
    egress: { ...test.ctx.egress, fetch: fixture.transport.fetch },
  };
  activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeApiRuntime(activation);
});
afterEach(async () => {
  cleanup();
  activation.dispose();
  await setActiveProject("personal");
  vaultStore.loadActiveProjectScope();
  await fixture.close();
});
function mount() {
  const provider = catalogProvider("github");
  if (!provider) throw new Error("Missing GitHub catalog row");
  const onFlash = vi.fn();
  const connection = deviceConnection(fixture.saved.connectionId);
  return {
    ...render(
      <MemoryRouter>
        <ConnectorSettingsPage
          provider={provider}
          providerId="github"
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
  mount();
  expect(screen.getByLabelText("Connection method")).toHaveProperty(
    "value",
    "token",
  );
  expect(screen.queryByTestId("github-app-presence")).toBeNull();
  expect(screen.queryByTestId("forge-backup-sync")).toBeNull();
  for (const [label, value] of [
    ["GitHub personal access token", githubBackupToken],
    ["Backup repository owner", parameters.backup_owner],
    ["Backup repository name", parameters.backup_repo],
    ["Backup repository branch", parameters.backup_branch],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect GitHub" }),
  );
  await screen.findByRole("form", { name: "Back up vault" });
}
async function coldReload() {
  cleanup();
  await kvFlush();
  kvForgetFiles(new Set(DEVICE_CONNECTOR_KEYS.map(kvFileName)));
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  return mount();
}
async function targetVault() {
  cleanup();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  const project = await createProject(`GitHub restore ${crypto.randomUUID()}`);
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin("68391527");
  const kept = createItem("note", "Keep destination note");
  await vaultStore.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  await coldReload();
  await screen.findByRole("form", { name: "Restore vault backup" });
  return { kept, identity };
}
it("configures, cold reloads, backs up and restores through shared forms into a different PIN vault", async () => {
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  const source = createItem("secret", "Mounted GitHub source");
  source.value = "mounted-github-ciphertext-canary";
  await vaultStore.saveItem(source);
  await configureTarget();
  await coldReload();
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
    target: { value: "83619472" },
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
  await expect(vaultStore.unlockWithPin("83619472")).rejects.toThrow();
  await vaultStore.unlockWithPin("68391527");
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
  expect(JSON.stringify(readDeviceRows())).not.toContain(githubBackupToken);
  expect([...fixture.local.files.values()].join()).not.toContain(
    githubBackupToken,
  );
  expect(
    fixture.state.requests.every(
      (row) =>
        row.url === "/user" ||
        row.url.startsWith("/repos/octocat/sealed-vault/"),
    ),
  ).toBe(true);
});
it.each(["unmount", "provider", "vault", "replacement"] as const)(
  "withdraws held actual PUT on %s without readback or late success",
  async (withdrawal) => {
    await configureNativeGithubPersonal(
      {
        ...fixture.draft,
        parameters,
        connectionId: fixture.saved.connectionId,
        revision: fixture.saved.revision,
      },
      fixture.transport,
    );
    await vaultStore.saveItem(createItem("note", "Held GitHub source"));
    fixture.state.hold = "PUT";
    const mounted = mount();
    fireEvent.submit(
      await screen.findByRole("form", { name: "Back up vault" }),
    );
    await waitFor(() => expect(fixture.state.held?.method).toBe("PUT"));
    if (withdrawal === "unmount") mounted.unmount();
    if (withdrawal === "provider") fixture.provider.abort();
    if (withdrawal === "vault") vaultStore.lock();
    if (withdrawal === "replacement")
      await configureNativeGithubPersonal(
        {
          ...fixture.draft,
          parameters,
          connectionId: fixture.saved.connectionId,
          revision: fixture.saved.revision + 1,
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
