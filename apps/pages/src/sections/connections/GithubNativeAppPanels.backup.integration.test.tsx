/** @vitest-environment jsdom */
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
} from "@opensesame/app-core/lib/backup-target-local.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { ensureDeviceIdentityKey } from "@opensesame/app-core/lib/device-identity-key.js";
import { useGithubBackupProviderFixture } from "@opensesame/app-core/lib/github-app-backup-provider.test-support.js";
import { credentials } from "@opensesame/app-core/lib/github-app-direct.test-support.js";
import { rememberLocalGithubApp } from "@opensesame/app-core/lib/github-app-local.js";
import {
  pemFromVault,
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "@opensesame/app-core/lib/github-app-secret.js";
import {
  createProject,
  setActiveProject,
} from "@opensesame/app-core/lib/projects.js";
import { stopVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { ConnectionsSection } from "../ConnectionsSection.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

// App reads return GitHub's numeric ID; old backup-only fixture defaults remain unchanged.
const fixture = useGithubBackupProviderFixture({ appId: "42", branch: "main" });
beforeEach(() => {
  // The provider fixture's fixed lease is for standalone protocol tests.
  // The parent uses the real approved tutorial plan and its current lease.
  vi.mocked(compositionStore.currentLease).mockRestore();
  vi.mocked(compositionStore.getSnapshot).mockRestore();
});
declareConnectionsTutorial();
afterEach(() => {
  cleanup();
  stopVaultBackupObserver();
});
function mountParent() {
  const provider = catalogProvider("github");
  if (!provider) throw new Error("Missing actual GitHub catalog provider");
  vi.spyOn(connectionSeams, "listConnections").mockResolvedValue([]);
  vi.spyOn(connectionSeams, "listIntegrations").mockResolvedValue([]);
  vi.spyOn(vercelCatalogSeams, "providers").mockReturnValue([provider]);
  vi.spyOn(identityHookSeams, "useIdentitySession").mockReturnValue(null);
  vi.spyOn(useOnlineSeams, "useOnline").mockReturnValue(true);
  window.history.replaceState({}, "", "/connections/github");
  return render(
    <MemoryRouter initialEntries={["/connections/github"]}>
      <Routes>
        <Route
          path="/connections/:providerId"
          element={<ConnectionsSection />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
async function chooseRepository() {
  await screen.findByTestId("github-app-name");
  const field = await screen.findByRole("combobox", { name: "Repository" });
  await waitFor(() => expect(field).toHaveProperty("disabled", false));
  await userEvent.click(
    screen.getByRole("button", { name: "Show repositories" }),
  );
  const choice = await screen.findByRole("option", {
    name: /fixture-owner\/backups/u,
  });
  fireEvent.mouseDown(choice);
  await waitFor(() =>
    expect(readLocalBackupTarget("github")).toMatchObject({
      kind: "github_app",
      installationId: "77",
      owner: "fixture-owner",
      repo: "backups",
      branch: "main",
    }),
  );
  await screen.findByTestId("github-backup-repo");
}
async function waitForWrites(count: number) {
  await waitFor(() =>
    expect(
      fixture.requests.filter((request) => request.method === "PUT"),
    ).toHaveLength(count),
  );
  await waitFor(() =>
    expect(readLocalBackupTarget("github")?.lastCommitSha).toBe(fixture.head),
  );
}

it("the full native parent composes the installed App summary once, selects a real repository, syncs ciphertext, and restores it into an independent cold PIN vault", async () => {
  clearLocalBackupTarget("github");
  stopVaultBackupObserver();
  rememberLocalGithubApp({
    ...fixture.app,
    htmlUrl:
      "https://github.com/apps/owned-backup-fixture?ignored=value#fragment",
  });
  expect(pemFromVault(fixture.app)).not.toBeNull();
  const source = mountParent();
  await chooseRepository();
  expect(screen.getAllByTestId("github-app-name")).toHaveLength(1);
  expect(screen.getAllByTestId("github-app-owner")).toHaveLength(1);
  expect(
    screen.getAllByRole("button", {
      name: "Remove GitHub App from this device",
    }),
  ).toHaveLength(1);
  expect(
    screen
      .getByRole("link", { name: "Install GitHub App" })
      .getAttribute("href"),
  ).toBe("https://github.com/apps/owned-backup-fixture/installations/new");
  expect(screen.queryByText("Saved app")).toBeNull();
  expect(readDeviceRows().filter((row) => row.providerId === "github")).toEqual(
    [],
  );
  expect(fixture.requests.some((request) => request.path === "/app")).toBe(
    true,
  );
  expect(
    fixture.requests.some(
      (request) => request.path === "/app/installations?per_page=100&page=1",
    ),
  ).toBe(true);
  expect(
    fixture.requests.some(
      (request) =>
        request.path === "/installation/repositories?per_page=100&page=1",
    ),
  ).toBe(true);
  expect(
    fixture.requests.filter((request) => request.method === "PUT"),
  ).toEqual([]);
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Back up this vault and enable automatic backups",
    }),
  );
  await waitForWrites(1);
  await userEvent.click(
    await screen.findByRole("button", { name: "Sync vault backup now" }),
  );
  await waitForWrites(2);
  const ciphertext = fixture.contents?.toString();
  const sourceCommit = fixture.head;
  expect(ciphertext).toBeTruthy();
  expect(ciphertext).not.toContain("owned-direct-backup-encrypted-canary");
  expect(ciphertext).not.toContain("BEGIN RSA PRIVATE KEY");
  source.unmount();
  stopVaultBackupObserver();
  clearLocalBackupTarget("github");
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  const destination = await createProject(
    `Full native App restore ${crypto.randomUUID()}`,
  );
  vaultStore.lock();
  await setActiveProject(destination.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin("68391527");
  const kept = createItem("note", "Destination-only full-parent note");
  await vaultStore.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  // Re-enter and genuinely seal the operator App key in the destination; never borrow a locked source.
  stashPendingGithubAppSecret(fixture.app, credentials.privateKey);
  await sealPendingGithubAppSecret();
  await vaultStore.flushPendingWrites();
  mountParent();
  await chooseRepository();
  expect(screen.getAllByTestId("github-app-presence")).toHaveLength(1);
  const readsBefore = fixture.requests.filter(
    (request) =>
      request.method === "GET" && request.path.includes("/contents/"),
  ).length;
  fireEvent.click(
    await screen.findByRole("button", { name: "Read encrypted vault backup" }),
  );
  const restore = await screen.findByRole("form", {
    name: "Restore vault backup",
  });
  expect(screen.getByLabelText("Backup name or ID")).toHaveProperty(
    "readOnly",
    true,
  );
  fireEvent.change(screen.getByLabelText("Backup password or PIN"), {
    target: { value: "83619472" },
  });
  fireEvent.submit(restore);
  await screen.findByRole("img", {
    name: /items restored from encrypted backup/u,
  });
  expect(screen.getByLabelText("Backup password or PIN")).toHaveProperty(
    "value",
    "",
  );
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: kept.id }),
      expect.objectContaining({ id: fixture.source.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb)).keyId,
  ).toBe(identity.keyId);
  expect(fixture.contents?.toString()).toBe(ciphertext);
  expect(fixture.head).toBe(sourceCommit);
  expect(
    fixture.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(2);
  const immutableReads = fixture.requests
    .filter(
      (request) =>
        request.method === "GET" && request.path.includes("/contents/"),
    )
    .slice(readsBefore);
  expect(immutableReads.length).toBeGreaterThan(0);
  expect(
    immutableReads.every(
      (request) =>
        new URL(request.path, "https://api.github.com").searchParams.get(
          "ref",
        ) === sourceCommit,
    ),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Close encrypted backup" }),
  );
  cleanup();
  stopVaultBackupObserver();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  act(() => vaultStore.lock());
  await expect(vaultStore.unlockWithPin("83619472")).rejects.toThrow();
  await vaultStore.unlockWithPin("68391527");
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: kept.id }),
      expect.objectContaining({ id: fixture.source.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb)).keyId,
  ).toBe(identity.keyId);
});

it("the full parent cannot turn cached App/install metadata into an authenticated restore when GitHub refuses its key", async () => {
  fixture.mode = "denied";
  mountParent();
  await screen.findByTestId("github-app-name");
  fireEvent.click(
    await screen.findByRole("button", { name: "Read encrypted vault backup" }),
  );
  await screen.findByRole("img", {
    name: "The encrypted GitHub backup could not be read.",
  });
  expect(
    screen.queryByRole("form", { name: "Restore vault backup" }),
  ).toBeNull();
  expect(
    fixture.requests.filter((request) => request.method === "PUT"),
  ).toEqual([]);
  expect(readDeviceRows().filter((row) => row.providerId === "github")).toEqual(
    [],
  );
  expect(fixture.outcomes.some((result) => result.status === 403)).toBe(true);
});
