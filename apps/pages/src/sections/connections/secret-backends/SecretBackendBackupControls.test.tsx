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

function handle(
  writable = true,
  signal?: AbortSignal,
  backendSignal?: AbortSignal,
) {
  const backend: SecretBackend = {
    id: "fixture",
    name: "Fixture",
    signal: backendSignal,
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
    session: { id: "one", backendId: "fixture", authenticatedAt: "", signal },
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
      name: "opensesame-vault-backup",
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
    "opensesame-vault-backup",
    expect.any(Function),
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
    expect.any(Function),
  );
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function heldTransfer(kind: "backup" | "restore", id = "held-backup") {
  const backup = deferred<SecretBackendItemSummary>();
  const restore = deferred<number>();
  let current: (() => void) | undefined;
  if (kind === "backup")
    vi.spyOn(dependencies, "backup").mockImplementationOnce(
      (_handle, _name, check) => {
        current = check;
        return backup.promise;
      },
    );
  else
    vi.spyOn(dependencies, "restore").mockImplementationOnce(
      (_handle, _reference, _secret, check) => {
        current = check;
        return restore.promise;
      },
    );
  return {
    check() {
      if (!current) throw new Error("Expected the actual action owner check");
      current();
    },
    complete() {
      if (kind === "backup") backup.resolve({ id, name: "Held", kind: "note" });
      else restore.resolve(3);
    },
    reject() {
      const error = new Error("Late transfer failure");
      if (kind === "backup") backup.reject(error);
      else restore.reject(error);
    },
  };
}
async function startTransfer(
  user: ReturnType<typeof userEvent.setup>,
  kind: "backup" | "restore",
) {
  if (kind === "restore") {
    await user.type(screen.getByLabelText("Backup name or ID"), "held-backup");
    await user.type(
      screen.getByLabelText("Backup password or PIN"),
      "48291037",
    );
  }
  await user.click(
    screen.getByRole("button", {
      name:
        kind === "backup"
          ? "Back up encrypted vault"
          : "Restore encrypted vault backup",
    }),
  );
}

it.each([
  ["backup", "resolve"],
  ["backup", "reject"],
  ["restore", "resolve"],
  ["restore", "reject"],
] as const)(
  "withdraws held %s on unmount before late %s",
  async (kind, late) => {
    const held = heldTransfer(kind);
    const flash = vi.fn();
    const view = render(
      <SecretBackendBackupControls handle={handle()} onFlash={flash} />,
    );
    await startTransfer(userEvent.setup(), kind);
    expect(() => held.check()).not.toThrow();
    view.unmount();
    expect(() => held.check()).toThrow("This action ended.");
    await act(async () => {
      if (late === "resolve") held.complete();
      else held.reject();
    });
    render(<SecretBackendBackupControls handle={handle()} onFlash={flash} />);
    expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
    expect(
      screen.queryByRole("img", {
        name: /saved and verified|restored from encrypted backup|Late transfer failure/,
      }),
    ).toBeNull();
    expect(flash).not.toHaveBeenCalled();
  },
);

it.each([
  ["backup", "session"],
  ["restore", "session"],
  ["backup", "backend"],
  ["restore", "backend"],
] as const)(
  "withdraws held %s when its actual %s lifetime ends",
  async (kind, lifetime) => {
    const owner = new AbortController();
    const held = heldTransfer(kind);
    const flash = vi.fn();
    render(
      <SecretBackendBackupControls
        handle={handle(
          true,
          lifetime === "session" ? owner.signal : undefined,
          lifetime === "backend" ? owner.signal : undefined,
        )}
        onFlash={flash}
      />,
    );
    await startTransfer(userEvent.setup(), kind);
    expect(() => held.check()).not.toThrow();
    act(() => owner.abort());
    expect(() => held.check()).toThrow("This action ended.");
    await act(async () => held.complete());
    expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
    expect(
      screen.queryByRole("img", {
        name: /saved and verified|restored from encrypted backup/,
      }),
    ).toBeNull();
    expect(screen.getByLabelText("Backup name")).toHaveProperty(
      "disabled",
      false,
    );
    expect(flash).not.toHaveBeenCalled();
  },
);

it("keeps a replacement session's pending backup independent of the old completion", async () => {
  const first = handle(true, new AbortController().signal);
  const second = handle(true, new AbortController().signal);
  second.session.id = "replacement";
  const flash = vi.fn();
  const old = heldTransfer("backup", "old-reference");
  const view = render(
    <SecretBackendBackupControls
      key={`backup-${first.session.id}`}
      handle={first}
      onFlash={flash}
    />,
  );
  const user = userEvent.setup();
  await startTransfer(user, "backup");
  old.check();
  view.rerender(
    <SecretBackendBackupControls
      key={`backup-${second.session.id}`}
      handle={second}
      onFlash={flash}
    />,
  );
  expect(() => old.check()).toThrow("This action ended.");
  const next = heldTransfer("backup", "new-reference");
  await startTransfer(user, "backup");
  await act(async () => old.complete());
  next.check();
  expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
  expect(screen.getByLabelText("Backup name")).toHaveProperty("disabled", true);
  await act(async () => next.complete());
  expect(await screen.findByLabelText("Saved backup ID")).toHaveProperty(
    "value",
    "new-reference",
  );
  expect(flash).not.toHaveBeenCalled();
});

it("refuses an already-ended provider session without starting either transfer", async () => {
  const backup = vi.spyOn(dependencies, "backup");
  const restore = vi.spyOn(dependencies, "restore");
  const flash = vi.fn();
  render(
    <SecretBackendBackupControls
      handle={handle(true, AbortSignal.abort())}
      onFlash={flash}
    />,
  );
  const user = userEvent.setup();
  await startTransfer(user, "backup");
  await startTransfer(user, "restore");
  expect(backup).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(flash).not.toHaveBeenCalled();
});
