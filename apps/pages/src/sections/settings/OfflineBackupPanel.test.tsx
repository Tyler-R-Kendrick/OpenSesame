import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vaultState: {
  current: {
    header: JsonObject | null;
    status: "empty" | "locked" | "unlocked";
  };
} = vi.hoisted(() => ({
  current: {
    header: null,
    status: "empty",
  },
}));
const importSealed = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vaultState.current,
  useVaultStore: () => ({ importSealed }),
});

const kvGet = vi.hoisted(() => vi.fn());

import { kvSeams } from "../../lib/kv.js";
const originalKvSeams = { ...kvSeams };
Object.assign(kvSeams, { kvGet });

const loadSettings = vi.hoisted(() => vi.fn());

import { settingsSeams } from "../../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, { loadSettings });
const buildOfflineBackup = vi.hoisted(() => vi.fn());
const serializeOfflineBackup = vi.hoisted(() => vi.fn());
const parseOfflineBackup = vi.hoisted(() => vi.fn());
const cacheCiphertextSnapshot = vi.hoisted(() => vi.fn());
const enqueueOfflineMutation = vi.hoisted(() => vi.fn());

import { offlineBackupSeams } from "../../lib/vault/offline-backup.js";
const originalOfflineBackupSeams = { ...offlineBackupSeams };
Object.assign(offlineBackupSeams, {
  buildOfflineBackup,
  serializeOfflineBackup,
  parseOfflineBackup,
  cacheCiphertextSnapshot,
  enqueueOfflineMutation,
});

import { OfflineBackupPanel } from "./OfflineBackupPanel.js";

const sealedBody = { v: 1, ct: "deadbeef" };

function unlockedVault() {
  vaultState.current = {
    header: { v: 1, kdf: "argon2id" },
    status: "unlocked",
  };
}

describe("OfflineBackupPanel", () => {
  beforeEach(() => {
    unlockedVault();
    loadSettings.mockReturnValue({ activeProjectId: "proj_1" });
    kvGet.mockReturnValue(JSON.stringify(sealedBody));
    buildOfflineBackup.mockReturnValue({ format: "opensesame-offline-backup" });
    serializeOfflineBackup.mockReturnValue('{"format":"opensesame"}');
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

  it("disables export while the vault is empty", () => {
    vaultState.current = { header: null, status: "empty" };
    render(<OfflineBackupPanel />);
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: /Download offline backup/i,
    });
    expect(button.disabled).toBe(true);
  });

  it("downloads a serialized backup envelope on export", async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<OfflineBackupPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Download offline backup/i }),
    );
    expect(buildOfflineBackup).toHaveBeenCalledWith({
      projectId: "proj_1",
      header: vaultState.current.header,
      body: sealedBody,
    });
    expect(cacheCiphertextSnapshot).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(
      /Downloaded an encrypted offline backup/,
    );
    click.mockRestore();
  });

  it("fails export when there is no stored ciphertext body", async () => {
    kvGet.mockReturnValue(null);
    render(<OfflineBackupPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Download offline backup/i }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /nothing stored to export/i,
    );
  });

  it("fails export when the body is not valid JSON", async () => {
    kvGet.mockReturnValue("{not json");
    render(<OfflineBackupPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Download offline backup/i }),
    );
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("shows the active project in the hint", () => {
    render(<OfflineBackupPanel />);
    expect(screen.getByText(/Active project:/)).toBeTruthy();
    expect(screen.getByText("proj_1")).toBeTruthy();
  });

  it("notes device-wide backup when no project is active", () => {
    loadSettings.mockReturnValue({ activeProjectId: "  " });
    render(<OfflineBackupPanel />);
    expect(screen.getByText(/backup is device-wide/i)).toBeTruthy();
  });

  function makeFile(name: string, contents = "{}"): File {
    const file = new File([contents], name, { type: "application/json" });
    // jsdom's File does not implement Blob#text; the panel awaits it.
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(contents),
    });
    return file;
  }

  function pickFile(file: File) {
    const input = document.getElementById("offline-backup-file");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("backup input not found");
    }
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("refuses to import without the backup password", async () => {
    render(<OfflineBackupPanel />);
    pickFile(makeFile("backup.json"));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Enter the master password/i,
    );
    expect(parseOfflineBackup).not.toHaveBeenCalled();
  });

  it("refuses backups larger than 64 MB", async () => {
    render(<OfflineBackupPanel />);
    await userEvent.type(
      screen.getByLabelText(/Master password for restore/i),
      "hunter2",
    );
    const file = makeFile("big.json");
    Object.defineProperty(file, "size", { value: 64 * 1024 * 1024 + 1 });
    pickFile(file);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /larger than 64 MB/i,
    );
  });

  it("restores items from a valid encrypted backup", async () => {
    parseOfflineBackup.mockReturnValue({
      exportedAt: "2026-08-01T00:00:00Z",
      projectId: "proj_1",
      vault: { header: {}, body: {} },
      syncBlobs: [],
    });
    importSealed.mockResolvedValue(2);
    render(<OfflineBackupPanel />);
    await userEvent.type(
      screen.getByLabelText(/Master password for restore/i),
      "hunter2",
    );
    pickFile(makeFile("backup.json"));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Restored 2 items from encrypted backup/,
    );
    expect(importSealed).toHaveBeenCalledWith(
      expect.stringContaining("opensesame-vault-export"),
      "hunter2",
    );
    // Password field is cleared after a successful restore.
    expect(
      screen.getByLabelText<HTMLInputElement>(/Master password for restore/i)
        .value,
    ).toBe("");
  });

  it("reports when a backup adds no new items", async () => {
    parseOfflineBackup.mockReturnValue({
      exportedAt: "2026-08-01T00:00:00Z",
      projectId: "proj_1",
      vault: { header: {}, body: {} },
      syncBlobs: [],
    });
    importSealed.mockResolvedValue(0);
    render(<OfflineBackupPanel />);
    await userEvent.type(
      screen.getByLabelText(/Master password for restore/i),
      "hunter2",
    );
    pickFile(makeFile("backup.json"));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /no new items/i,
    );
  });

  it("queues sync blobs for upload while offline", async () => {
    parseOfflineBackup.mockReturnValue({
      exportedAt: "2026-08-01T00:00:00Z",
      projectId: "proj_1",
      vault: { header: {}, body: {} },
      syncBlobs: [{ id: "blob_1" }],
    });
    importSealed.mockResolvedValue(1);
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<OfflineBackupPanel />);
    await userEvent.type(
      screen.getByLabelText(/Master password for restore/i),
      "hunter2",
    );
    pickFile(makeFile("backup.json"));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Restored 1 item/,
    );
    expect(enqueueOfflineMutation).toHaveBeenCalledWith({
      kind: "push_sync_blobs",
      projectId: "proj_1",
      blobs: [{ id: "blob_1" }],
    });
    onLine.mockRestore();
  });

  it("does not queue sync blobs while online", async () => {
    parseOfflineBackup.mockReturnValue({
      exportedAt: "2026-08-01T00:00:00Z",
      projectId: "proj_1",
      vault: { header: {}, body: {} },
      syncBlobs: [{ id: "blob_1" }],
    });
    importSealed.mockResolvedValue(1);
    render(<OfflineBackupPanel />);
    await userEvent.type(
      screen.getByLabelText(/Master password for restore/i),
      "hunter2",
    );
    pickFile(makeFile("backup.json"));
    await screen.findByRole("status");
    expect(enqueueOfflineMutation).not.toHaveBeenCalled();
  });

  it("surfaces import failures", async () => {
    parseOfflineBackup.mockImplementation(() => {
      throw new Error("corrupt envelope");
    });
    render(<OfflineBackupPanel />);
    await userEvent.type(
      screen.getByLabelText(/Master password for restore/i),
      "hunter2",
    );
    pickFile(makeFile("backup.json"));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /corrupt envelope/,
    );
  });

  it("disables the password field while the vault is locked", () => {
    vaultState.current = { header: { v: 1 }, status: "locked" };
    render(<OfflineBackupPanel />);
    expect(
      overlapCast(screen.getByLabelText(/Master password for restore/i))
        .disabled,
    ).toBe(true);
  });
});
