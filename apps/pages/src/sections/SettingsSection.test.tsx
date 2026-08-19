import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  current: {
    prefs: {
      theme: "system",
      autoLockMinutes: 0,
      clipboardClearSeconds: 30,
      lockOnHide: false,
      signOutOnLock: false,
    },
    items: [] as unknown[],
    folders: [] as { id: string; name: string; createdAt: string }[],
    header: null as Record<string, unknown> | null,
  },
}));
const store = vi.hoisted(() => ({
  setPrefs: vi.fn(),
  changeMasterPassword: vi.fn(),
  addFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  addItems: vi.fn(),
  replaceAll: vi.fn(),
  exportSealed: vi.fn(),
  importSealed: vi.fn(),
  applyManifestMerge: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../lib/vault/hooks.js", () => ({
  useVault: () => vault.current,
  useVaultStore: () => store,
}));

const loadSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn());

vi.mock("../lib/settings.js", () => ({ loadSettings, saveSettings }));

const checkTurso = vi.hoisted(() => vi.fn());
const setTursoSessionToken = vi.hoisted(() => vi.fn());

vi.mock("../lib/embedded-catalog.js", () => ({
  checkTurso,
  setTursoSessionToken,
}));

vi.mock("../lib/vault/password.js", () => ({
  estimateStrength: (password: string) => ({
    score: password.length >= 12 ? 3 : 1,
    label: password.length >= 12 ? "Strong" : "Weak",
    bits: password.length * 4,
  }),
}));

vi.mock("../lib/vault/sample.js", () => ({
  SAMPLE_FOLDER_NAME: "Samples",
  buildSample: (folderId: string) => [
    { id: "itm_sample", kind: "login", name: "Sample", folderId },
  ],
  sampleFolder: () => ({ id: "fld_samples", name: "Samples" }),
}));

const planManifestMerge = vi.hoisted(() => vi.fn());
const vaultItemToEntry = vi.hoisted(() => vi.fn());

vi.mock("../lib/vault/store-sync.js", () => ({
  planManifestMerge,
  vaultItemToEntry,
}));

vi.mock("../components/PlaneNote.js", () => ({
  ConnectThisMachine: () => <div data-testid="plane-note" />,
}));

vi.mock("./settings/ActiveProjectPanel.js", () => ({
  ActiveProjectPanel: () => <div data-testid="active-project-panel" />,
}));
vi.mock("./settings/CapabilityConnectorsPanel.js", () => ({
  CapabilityConnectorsPanel: () => (
    <div data-testid="capability-connectors-panel" />
  ),
}));
vi.mock("./settings/ChangelogPanel.js", () => ({
  ChangelogPanel: () => <div data-testid="changelog-panel" />,
}));
vi.mock("./settings/GithubBackupPanel.js", () => ({
  GithubBackupPanel: () => <div data-testid="github-backup-panel" />,
}));
vi.mock("./settings/ImportPanel.js", () => ({
  ImportPanel: () => <div data-testid="import-panel" />,
}));
vi.mock("./settings/OfflineBackupPanel.js", () => ({
  OfflineBackupPanel: () => <div data-testid="offline-backup-panel" />,
}));
vi.mock("./settings/SyncTargetsPanel.js", () => ({
  SyncTargetsPanel: () => <div data-testid="sync-targets-panel" />,
}));
vi.mock("./settings/TaskBusPanel.js", () => ({
  TaskBusPanel: () => <div data-testid="taskbus-panel" />,
}));
vi.mock("./settings/UnlockMethodsPanel.js", () => ({
  UnlockMethodsPanel: () => <div data-testid="unlock-methods-panel" />,
}));

import { SettingsSection } from "./SettingsSection.js";

const endpoints = {
  hostApi: "http://127.0.0.1:8787",
  identityApi: "http://127.0.0.1:8788",
  daemonApi: "http://127.0.0.1:18790",
  tursoUrl: "",
  mfaAppUrl: "",
  capabilityConnectors: {},
};

function renderSettings(hash = "") {
  return render(
    <MemoryRouter initialEntries={[`/settings${hash}`]}>
      <SettingsSection />
    </MemoryRouter>,
  );
}

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "application/json" });
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(contents),
  });
  return file;
}

describe("SettingsSection", () => {
  beforeEach(() => {
    vault.current = {
      prefs: {
        theme: "system",
        autoLockMinutes: 0,
        clipboardClearSeconds: 30,
        lockOnHide: false,
        signOutOnLock: false,
      },
      items: [],
      folders: [],
      header: { wrap: {}, kdf: { iterations: 600_000 } },
    };
    loadSettings.mockReturnValue({ ...endpoints });
    checkTurso.mockResolvedValue("embedded");
    store.exportSealed.mockReturnValue('{"sealed":true}');
    store.importSealed.mockResolvedValue(2);
    store.addFolder.mockResolvedValue({ id: "fld_new", name: "Samples" });
    store.addItems.mockResolvedValue(undefined);
    store.replaceAll.mockResolvedValue(undefined);
    store.changeMasterPassword.mockResolvedValue(undefined);
    store.applyManifestMerge.mockResolvedValue(undefined);
    planManifestMerge.mockReturnValue({
      adds: [{}],
      updates: [],
      unchanged: 0,
    });
    vaultItemToEntry.mockReturnValue({ path: "Dev/token" });
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:mock"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens on General with appearance and locking controls", () => {
    renderSettings();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Locking")).toBeTruthy();
    // Child panels from other categories stay unmounted.
    expect(screen.queryByTestId("unlock-methods-panel")).toBeNull();
    expect(screen.queryByTestId("taskbus-panel")).toBeNull();
  });

  it("switches theme and locking preferences", async () => {
    renderSettings();
    await userEvent.click(screen.getByRole("button", { name: /Dark/i }));
    expect(store.setPrefs).toHaveBeenCalledWith({ theme: "dark" });

    await userEvent.selectOptions(
      screen.getByLabelText(/Lock after inactivity/i),
      "60",
    );
    expect(store.setPrefs).toHaveBeenCalledWith({ autoLockMinutes: 60 });

    await userEvent.selectOptions(
      screen.getByLabelText(/Clear copied secrets after/i),
      "0",
    );
    expect(store.setPrefs).toHaveBeenCalledWith({ clipboardClearSeconds: 0 });

    await userEvent.click(
      screen.getByLabelText(/Lock when this tab goes to the background/i),
    );
    expect(store.setPrefs).toHaveBeenCalledWith({ lockOnHide: true });

    await userEvent.click(
      screen.getByLabelText(/Also sign out of Identity when the vault locks/i),
    );
    expect(store.setPrefs).toHaveBeenCalledWith({ signOutOnLock: true });
  });

  it("activates categories from the hash and the nav", async () => {
    renderSettings("#taskbus");
    expect(screen.getByTestId("taskbus-panel")).toBeTruthy();
    const nav = screen.getByRole("navigation", {
      name: /Settings sections/i,
    });
    expect(
      nav.querySelector('[aria-current="true"]')?.textContent?.toLowerCase(),
    ).toBe("connectivity");

    await userEvent.click(screen.getByRole("button", { name: /Danger/i }));
    expect(
      screen.getByRole("heading", { name: "Delete this vault" }),
    ).toBeTruthy();
  });

  it("maps the legacy #import hash to Vault data", () => {
    renderSettings("#import");
    expect(screen.getByTestId("import-panel")).toBeTruthy();
  });

  it("shows the security category with unlock methods and master password", async () => {
    renderSettings("#security");
    expect(screen.getByTestId("unlock-methods-panel")).toBeTruthy();
    expect(screen.getByText(/600,000 PBKDF2-SHA256 iterations/)).toBeTruthy();
  });

  it("rejects mismatched master password entries", async () => {
    renderSettings("#security");
    await userEvent.type(
      screen.getByLabelText(/Current master password/i),
      "old-password-1",
    );
    await userEvent.type(
      screen.getByLabelText(/New master password/i),
      "new-password-12",
    );
    await userEvent.type(screen.getByLabelText(/^Confirm$/i), "different-123");
    fireEvent.submit(
      screen
        .getByRole("button", { name: /Change master password/i })
        .closest("form") as HTMLFormElement,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/do not match/)).toBeTruthy();
    expect(store.changeMasterPassword).not.toHaveBeenCalled();
  });

  it("changes the master password and clears the form", async () => {
    renderSettings("#security");
    await userEvent.type(
      screen.getByLabelText(/Current master password/i),
      "old-password-1",
    );
    await userEvent.type(
      screen.getByLabelText(/New master password/i),
      "new-password-12",
    );
    await userEvent.type(
      screen.getByLabelText(/^Confirm$/i),
      "new-password-12",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change master password/i }),
    );
    expect(store.changeMasterPassword).toHaveBeenCalledWith(
      "old-password-1",
      "new-password-12",
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Master password changed/,
    );
  });

  it("surfaces master password change failures", async () => {
    store.changeMasterPassword.mockRejectedValue(new Error("wrong current"));
    renderSettings("#security");
    await userEvent.type(
      screen.getByLabelText(/Current master password/i),
      "old-password-1",
    );
    await userEvent.type(
      screen.getByLabelText(/New master password/i),
      "new-password-12",
    );
    await userEvent.type(
      screen.getByLabelText(/^Confirm$/i),
      "new-password-12",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change master password/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /wrong current/,
    );
  });

  it("disables re-key when there is no password wrap or it is too weak", async () => {
    vault.current.header = null;
    renderSettings("#security");
    expect(screen.getByText(/no master-password unlock/)).toBeTruthy();
    const button = screen.getByRole("button", {
      name: /Change master password/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("shows the live strength hint for the new password", async () => {
    renderSettings("#security");
    await userEvent.type(
      screen.getByLabelText(/New master password/i),
      "new-password-12",
    );
    expect(screen.getByText(/Strong · 60 bits/)).toBeTruthy();
  });

  it("saves trimmed endpoint URLs and reports the Turso mode", async () => {
    checkTurso.mockResolvedValue("remote");
    renderSettings("#connectivity");
    const host = screen.getByLabelText(/^Host API$/i);
    await userEvent.clear(host);
    await userEvent.type(host, "https://host.example.com/");
    await userEvent.click(
      screen.getByRole("button", { name: /Save endpoints/i }),
    );
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        hostApi: "https://host.example.com",
        identityApi: "http://127.0.0.1:8788",
      }),
    );
    expect(setTursoSessionToken).toHaveBeenCalled();
    expect(
      await screen.findByText(/synchronized with the configured remote/),
    ).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("reports an in-memory fallback as an error", async () => {
    checkTurso.mockResolvedValue("memory");
    renderSettings("#connectivity");
    await userEvent.click(
      screen.getByRole("button", { name: /Save endpoints/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /bundled connector catalog in memory/,
    );
  });

  it("renders the connectivity child panels", () => {
    renderSettings("#connectivity");
    expect(screen.getByTestId("active-project-panel")).toBeTruthy();
    expect(screen.getByTestId("capability-connectors-panel")).toBeTruthy();
    expect(screen.getByTestId("sync-targets-panel")).toBeTruthy();
    expect(screen.getByTestId("taskbus-panel")).toBeTruthy();
  });

  it("renders the data category child panels", () => {
    renderSettings("#data");
    expect(screen.getByTestId("github-backup-panel")).toBeTruthy();
    expect(screen.getByTestId("changelog-panel")).toBeTruthy();
    expect(screen.getByTestId("offline-backup-panel")).toBeTruthy();
    expect(screen.getByTestId("import-panel")).toBeTruthy();
  });

  it("adds, renames, and deletes folders", async () => {
    vault.current.folders = [
      { id: "fld_1", name: "Work", createdAt: "2026-08-01" },
    ];
    renderSettings("#data");
    // Rename on blur with a changed name.
    const rename = screen.getByLabelText("Rename Work");
    fireEvent.change(rename, { target: { value: "Personal" } });
    fireEvent.blur(rename, { target: { value: "Personal" } });
    expect(store.renameFolder).toHaveBeenCalledWith("fld_1", "Personal");

    // Blur without a change does nothing.
    fireEvent.blur(screen.getByLabelText("Rename Work"), {
      target: { value: "Work" },
    });
    expect(store.renameFolder).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Delete folder Work" }),
    );
    expect(store.deleteFolder).toHaveBeenCalledWith("fld_1");

    await userEvent.type(screen.getByLabelText(/New folder/i), "Archive");
    await userEvent.click(screen.getByRole("button", { name: /Add folder/i }));
    expect(store.addFolder).toHaveBeenCalledWith("Archive");
  });

  it("shows the no-folders hint", () => {
    renderSettings("#data");
    expect(screen.getByText("No folders yet.")).toBeTruthy();
  });

  it("exports a plaintext store manifest for the unlocked vault", async () => {
    vault.current.items = [
      { id: "itm_1", deletedAt: null },
      { id: "itm_2", deletedAt: "2026-08-01" },
    ];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderSettings("#data");
    await userEvent.click(
      screen.getByRole("button", { name: /Download store path manifest/i }),
    );
    // Trashed items are excluded from the manifest.
    expect(vaultItemToEntry).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /plaintext path manifest/,
    );
    click.mockRestore();
  });

  it("imports a store manifest with a merge summary", async () => {
    planManifestMerge.mockReturnValue({
      adds: [{}],
      updates: [{}],
      unchanged: 3,
    });
    renderSettings("#data");
    const input = document.getElementById(
      "store-manifest-file",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile("manifest.json", '[{"path":"a"}]')] },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Merged 1 sealed-store entry: 1 added, 1 updated, 3 unchanged/,
    );
    expect(store.applyManifestMerge).toHaveBeenCalled();
  });

  it("rejects manifests that are not JSON arrays", async () => {
    renderSettings("#data");
    const input = document.getElementById(
      "store-manifest-file",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile("manifest.json", '{"nope":true}')] },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Expected a JSON array/,
    );
  });

  it("exports the encrypted vault", async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderSettings("#data");
    await userEvent.click(
      screen.getByRole("button", { name: /Export encrypted vault/i }),
    );
    expect(store.exportSealed).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /still ciphertext/,
    );
    click.mockRestore();
  });

  it("requires the export password before importing a vault", async () => {
    renderSettings("#data");
    const input = document.getElementById("import-file") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile("vault.json", "{}")] },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Enter the master password/,
    );
    expect(store.importSealed).not.toHaveBeenCalled();
  });

  it("imports a sealed vault export with its password", async () => {
    renderSettings("#data");
    await userEvent.type(
      screen.getByLabelText(/Master password that export was sealed under/i),
      "hunter2",
    );
    const input = document.getElementById("import-file") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile("vault.json", "{}")] },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Merged 2 items/,
    );
    expect(store.importSealed).toHaveBeenCalledWith("{}", "hunter2");
  });

  it("reports when an import adds nothing new", async () => {
    store.importSealed.mockResolvedValue(0);
    renderSettings("#data");
    await userEvent.type(
      screen.getByLabelText(/Master password that export was sealed under/i),
      "hunter2",
    );
    const input = document.getElementById("import-file") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile("vault.json", "{}")] },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /nothing this vault was missing/,
    );
  });

  it("loads sample items, creating the folder when needed", async () => {
    renderSettings("#data");
    await userEvent.click(
      screen.getByRole("button", { name: /Load SYNTHETIC sample items/i }),
    );
    expect(store.addFolder).toHaveBeenCalledWith("Samples");
    expect(store.addItems).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Sample items added/,
    );
  });

  it("reuses the existing sample folder when present", async () => {
    vault.current.folders = [
      { id: "fld_s", name: "Samples", createdAt: "2026-08-01" },
    ];
    renderSettings("#data");
    await userEvent.click(
      screen.getByRole("button", { name: /Load SYNTHETIC sample items/i }),
    );
    expect(store.addFolder).not.toHaveBeenCalled();
    expect(store.addItems).toHaveBeenCalled();
  });

  it("purges sample items and their folder", async () => {
    vault.current.items = [
      { id: "itm_1", sample: true, deletedAt: null },
      { id: "itm_2", sample: false, deletedAt: null },
    ];
    vault.current.folders = [
      { id: "fld_s", name: "Samples", createdAt: "2026-08-01" },
      { id: "fld_w", name: "Work", createdAt: "2026-08-01" },
    ];
    renderSettings("#data");
    await userEvent.click(
      screen.getByRole("button", { name: /Remove 1 SYNTHETIC item/i }),
    );
    expect(store.replaceAll).toHaveBeenCalledWith(
      [{ id: "itm_2", sample: false, deletedAt: null }],
      [{ id: "fld_w", name: "Work", createdAt: "2026-08-01" }],
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Sample items removed/,
    );
  });

  it("destroys the vault only after confirmation", async () => {
    vault.current.items = [{ id: "itm_1" }, { id: "itm_2" }];
    renderSettings("#danger");
    await userEvent.click(
      screen.getByRole("button", { name: /Delete this vault/i }),
    );
    expect(screen.getByText(/2 items will be unrecoverable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(store.destroy).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Delete this vault/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Delete permanently/i }),
    );
    expect(store.destroy).toHaveBeenCalled();
  });
});
