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
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  gitlabBackupToken,
  nativeGitlabBackupFixture,
} from "@opensesame/app-core/lib/native-gitlab-backup.test-support.js";
import {
  createProject,
  setActiveProject,
} from "@opensesame/app-core/lib/projects.js";
import { runtimePassword } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
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
import { bindNativeOAuthRuntime } from "../../../modules/connectors.external/native-oauth-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";

declareConnectionsTutorial();

let fixture: Awaited<ReturnType<typeof nativeGitlabBackupFixture>>;
let activation: ReturnType<typeof createActivation>;
let connectionId: string | undefined;
// Exercise real PIN custody at the production KDF floor. Short-PIN work-factor
// scaling is covered by pin-kdf and unlock-factor-pin-crypto tests.
const sourcePin = "8361947250816394";
const destinationPin = "6839152740968253";
const parameters = {
  backup_project: "owned-group/sealed-vault",
  backup_branch: "backup/encrypted",
};
beforeEach(async () => {
  connectionId = undefined;
  fixture = await nativeGitlabBackupFixture();
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
});
afterEach(async () => {
  cleanup();
  activation.dispose();
  await setActiveProject("personal");
  vaultStore.loadActiveProjectScope();
  await fixture.close();
});
function mount() {
  const provider = catalogProvider("gitlab");
  if (!provider) throw new Error("Missing GitLab catalog row");
  const onFlash = vi.fn();
  const connection = connectionId ? deviceConnection(connectionId) : null;
  return {
    ...render(
      <MemoryRouter>
        <ConnectorSettingsPage
          provider={provider}
          providerId="gitlab"
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
  fireEvent.click(screen.getByRole("radio", { name: "API Key" }));
  expect(screen.getByLabelText("GitLab API key")).toHaveProperty("value", "");
  fireEvent.click(screen.getByText("Sign-in options", { selector: "summary" }));
  for (const [label, value] of [
    ["GitLab API key", gitlabBackupToken],
    ["Backup project (optional)", parameters.backup_project],
    ["Backup branch (optional)", parameters.backup_branch],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const start = fixture.state.requests.length;
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect GitLab" }),
  );
  await screen.findByRole("form", { name: "Back up vault" }).catch((error) => {
    expect(mounted.onFlash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    );
    throw error;
  });
  expect(
    fixture.state.requests
      .slice(start)
      .some((row) => row.url === "/api/v4/user"),
  ).toBe(true);
  const created = readDeviceRows().filter(
    (row) =>
      row.providerId === "gitlab" &&
      row.connectionId !== fixture.saved.connectionId,
  );
  expect(created).toHaveLength(1);
  connectionId = created[0]?.connectionId;
  if (!connectionId)
    throw new Error("Expected actual newly configured GitLab connection");
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
async function targetVault() {
  cleanup();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  const project = await createProject(`GitLab restore ${crypto.randomUUID()}`);
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin(destinationPin);
  const kept = createItem("note", "Keep destination note");
  await vaultStore.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  await coldReload();
  await screen.findByRole("form", { name: "Restore vault backup" });
  return { kept, identity };
}
it("configures, cold reloads, backs up and restores through shared forms into a different PIN vault", async () => {
  await vaultStore.enrollPin(sourcePin);
  await vaultStore.removePassword();
  const source = createItem("secret", "Mounted GitLab source");
  source.value = "mounted-gitlab-ciphertext-canary";
  await vaultStore.saveItem(source);
  await configureTarget();
  await coldReload(sourcePin);
  expect(screen.getByLabelText("Backup branch (optional)")).toHaveProperty(
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
    target: { value: sourcePin },
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
  await expect(vaultStore.unlockWithPin(sourcePin)).rejects.toThrow();
  await vaultStore.unlockWithPin(destinationPin);
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
  expect(JSON.stringify(readDeviceRows())).not.toContain(gitlabBackupToken);
  expect([...fixture.local.files.values()].join()).not.toContain(
    gitlabBackupToken,
  );
  expect(
    fixture.state.requests.every(
      (row) =>
        row.url === "/api/v4/user" ||
        row.url.startsWith("/api/v4/projects/owned-group%2Fsealed-vault"),
    ),
  ).toBe(true);
});
it.each(["unmount", "provider", "vault", "replacement"] as const)(
  "withdraws held actual POST201 on %s without readback or late success",
  async (withdrawal) => {
    await heldWithdrawal("POST", withdrawal);
  },
);
it.each(["unmount", "provider", "vault", "replacement"] as const)(
  "withdraws held actual GET200 restore on %s without late success",
  async (withdrawal) => {
    await heldWithdrawal("GET", withdrawal);
  },
);
type Withdrawal = "unmount" | "provider" | "vault" | "replacement";
async function heldWithdrawal(method: "POST" | "GET", withdrawal: Withdrawal) {
  await vaultStore.saveItem(createItem("note", "Held GitLab source"));
  const mounted = await configureTarget();
  if (method === "GET") {
    fireEvent.submit(
      await screen.findByRole("form", { name: "Back up vault" }),
    );
    const saved = await screen.findByLabelText("Saved backup ID");
    await screen.findByRole("img", {
      name: "Encrypted vault backup saved and verified",
    });
    fireEvent.change(screen.getByLabelText("Backup name or ID"), {
      target: { value: saved.getAttribute("value") ?? "" },
    });
    fireEvent.change(screen.getByLabelText("Backup password or PIN"), {
      target: { value: runtimePassword },
    });
  }
  mounted.onFlash.mockClear();
  fixture.state.hold = method;
  fireEvent.submit(
    await screen.findByRole("form", {
      name: method === "POST" ? "Back up vault" : "Restore vault backup",
    }),
  );
  await waitFor(() => expect(fixture.state.held?.method).toBe(method));
  await waitFor(() =>
    expect(fixture.state.received.at(-1)).toEqual({
      path: fixture.state.held?.url,
      status: method === "POST" ? 201 : 200,
    }),
  );
  expect(fixture.state.held).toMatchObject({ closed: false, premature: false });
  expect(
    screen.getByLabelText(
      method === "POST" ? "Backup name" : "Backup name or ID",
    ),
  ).toHaveProperty("disabled", true);
  expect(mounted.onFlash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "err" }),
  );
  const heldIndex = fixture.state.requests.findIndex(
    (row) => row === fixture.state.held,
  );
  if (withdrawal === "unmount") mounted.unmount();
  if (withdrawal === "provider") fixture.provider.abort();
  if (withdrawal === "vault") vaultStore.lock();
  if (withdrawal === "replacement")
    await configureNativeApiConnector(
      {
        ...fixture.draft,
        parameters,
        connectionId,
        revision: readNativeConnector(connectionId ?? "")?.revision,
        displayName: "Changed mounted backup",
      },
      fixture.transport,
    );
  await waitFor(() =>
    expect(fixture.state.held).toMatchObject({ closed: true, premature: true }),
  );
  expect(
    fixture.state.requests
      .slice(heldIndex + 1)
      .filter((row) => row.url.includes("/repository/files/")),
  ).toEqual([]);
  expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
  expect(mounted.onFlash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
}
it("preserves fresh account-only connection, optional blank fields and actual membership-project action", async () => {
  mount();
  fireEvent.click(screen.getByRole("radio", { name: "API Key" }));
  fireEvent.click(screen.getByText("Sign-in options", { selector: "summary" }));
  for (const label of [
    "Backup project (optional)",
    "Backup branch (optional)",
  ]) {
    expect(screen.getByLabelText(label)).toHaveProperty("required", false);
    expect(screen.getByLabelText(label)).toHaveProperty("value", "");
  }
  fireEvent.change(screen.getByLabelText("GitLab API key"), {
    target: { value: gitlabBackupToken },
  });
  const start = fixture.state.requests.length;
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect GitLab" }),
  );
  await screen.findByRole("button", { name: "List membership projects" });
  expect(screen.queryByRole("form", { name: "Back up vault" })).toBeNull();
  expect(fixture.state.requests.slice(start).map((row) => row.url)).toEqual([
    "/api/v4/user",
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "List membership projects" }),
  );
  await screen.findByText("Showing 1 membership projects from first page");
  expect(fixture.state.requests.at(-1)?.url).toBe(
    "/api/v4/projects?membership=true&simple=true&per_page=20&page=1",
  );
});
