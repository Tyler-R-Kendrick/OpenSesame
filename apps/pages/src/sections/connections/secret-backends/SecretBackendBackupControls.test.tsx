/** @vitest-environment jsdom */
import type {
  SecretBackend,
  SecretBackendItemSummary,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  SecretBackendBackupControls,
  secretBackendBackupDependencies as dependencies,
} from "./SecretBackendBackupControls.js";

function handle(writable = true) {
  const backend: SecretBackend = {
    id: "fixture",
    name: "Fixture",
    capabilities: {
      list: true,
      get: true,
      create: writable,
      update: writable,
      delete: writable,
      import: !writable,
    },
    authenticate: vi.fn(async () => ({
      id: "one",
      backendId: "fixture",
      authenticatedAt: "",
    })),
    listItems: vi.fn(async () => []),
    getItem: vi.fn<SecretBackend["getItem"]>(async () => ({
      id: "backup",
      name: "Backup",
      kind: "note",
      notes: "",
      secret: "",
    })),
    getNotes: vi.fn(async () => ""),
    createItem: vi.fn<NonNullable<SecretBackend["createItem"]>>(
      async (input) => ({ ...input, id: "backup", kind: "note" }),
    ),
    disconnect: vi.fn(async () => undefined),
  };
  if (writable)
    backend.capabilities.vaultBackup = { kind: "note", field: "notes" };
  return {
    backend,
    session: { id: "one", backendId: "fixture", authenticatedAt: "" },
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("offers encrypted backup only on an adapter with an explicit backup capability", () => {
  render(
    <SecretBackendBackupControls handle={handle(false)} onFlash={vi.fn()} />,
  );
  expect(
    screen.queryByRole("button", { name: "Back up encrypted vault" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Restore encrypted vault backup" }),
  ).toBeTruthy();
});

it("shows verified backup success and the actual saved reference only after the transfer completes", async () => {
  let complete: (item: SecretBackendItemSummary) => void = () => {
    throw new Error("Transfer was not started");
  };
  vi.spyOn(dependencies, "backup").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const opened = handle();
  const user = userEvent.setup();
  render(<SecretBackendBackupControls handle={opened} onFlash={vi.fn()} />);
  expect(dependencies.backup).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Back up encrypted vault" }),
  );
  expect(
    screen.queryByRole("img", {
      name: "Encrypted vault backup saved and verified",
    }),
  ).toBeNull();
  expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
  await act(async () =>
    complete({
      id: "server-backup-17",
      name: "OpenSesame vault backup",
      kind: "note",
    }),
  );
  expect(await screen.findByLabelText("Saved backup ID")).toHaveProperty(
    "value",
    "server-backup-17",
  );
  expect(
    screen.getByRole("img", {
      name: "Encrypted vault backup saved and verified",
    }),
  ).toBeTruthy();
  expect(dependencies.backup).toHaveBeenCalledWith(
    opened,
    "OpenSesame vault backup",
  );
});

it("keeps failed backup settings and permits an explicit retry", async () => {
  vi.spyOn(dependencies, "backup")
    .mockRejectedValueOnce(
      new Error("Backend did not retain the encrypted payload"),
    )
    .mockResolvedValue({ id: "verified", name: "Retry backup", kind: "note" });
  const user = userEvent.setup();
  render(<SecretBackendBackupControls handle={handle()} onFlash={vi.fn()} />);
  await user.clear(screen.getByLabelText("Backup name"));
  await user.type(screen.getByLabelText("Backup name"), "Retry backup");
  await user.click(
    screen.getByRole("button", { name: "Back up encrypted vault" }),
  );
  await screen.findByRole("img", {
    name: "Backend did not retain the encrypted payload",
  });
  expect(screen.getByLabelText("Backup name")).toHaveProperty(
    "value",
    "Retry backup",
  );
  expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Back up encrypted vault" }),
  );
  expect(await screen.findByLabelText("Saved backup ID")).toHaveProperty(
    "value",
    "verified",
  );
});

it("restores only on explicit action and clears the transient backup unlock secret", async () => {
  vi.spyOn(dependencies, "restore").mockResolvedValue(3);
  const opened = handle();
  const user = userEvent.setup();
  render(<SecretBackendBackupControls handle={opened} onFlash={vi.fn()} />);
  await user.type(
    screen.getByLabelText("Backup name or ID"),
    "server-backup-17",
  );
  await user.type(screen.getByLabelText("Backup password or PIN"), "48291037");
  expect(dependencies.restore).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Restore encrypted vault backup" }),
  );
  await screen.findByRole("img", {
    name: "3 items restored from encrypted backup",
  });
  expect(screen.getByLabelText("Backup password or PIN")).toHaveProperty(
    "value",
    "",
  );
  expect(dependencies.restore).toHaveBeenCalledWith(
    opened,
    "server-backup-17",
    "48291037",
  );
});
