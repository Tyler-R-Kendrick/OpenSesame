/** @vitest-environment jsdom */
import type {
  SecretBackend,
  SecretBackendItem,
  SecretBackendItemInput,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SecretBackendWorkspace } from "./SecretBackendWorkspace.js";

const session = {
  id: "session-one",
  backendId: "fixture",
  authenticatedAt: "2026-10-14T00:00:00Z",
};
function backend(readOnly = false): SecretBackend {
  let items: SecretBackendItem[] = [
    {
      id: "note-one",
      name: "Deployment",
      kind: "note",
      notes: "Actual backend notes",
      secret: "",
    },
  ];
  const find = (id: string) => {
    const item = items.find((entry) => entry.id === id || entry.name === id);
    if (!item) throw new Error("Item not found");
    return { ...item };
  };
  return {
    id: "fixture",
    name: "Fixture backend",
    capabilities: {
      list: true,
      get: true,
      create: !readOnly,
      update: !readOnly,
      delete: !readOnly,
      import: readOnly,
    },
    authenticate: vi.fn(async () => session),
    listItems: vi.fn(async () =>
      items.map(({ id, name, kind }) => ({ id, name, kind })),
    ),
    getItem: vi.fn(async (id) => find(id)),
    getNotes: vi.fn(async (id) => find(id).notes),
    createItem: vi.fn(async (input: SecretBackendItemInput) => {
      const item: SecretBackendItem = {
        ...input,
        kind: input.kind ?? "note",
        id: "note-two",
      };
      items.push(item);
      return item;
    }),
    updateItem: vi.fn(async (id, input) => {
      const item = { ...find(id), ...input };
      items = items.map((entry) => (entry.id === id ? item : entry));
      return item;
    }),
    deleteItem: vi.fn(async (id) => {
      items = items.filter((entry) => entry.id !== id);
    }),
    importToLocal: vi.fn(async () => ({
      imported: 1,
      skipped: 0,
      warnings: [],
    })),
    disconnect: vi.fn(async () => undefined),
  };
}
function draw(value: SecretBackend) {
  return render(
    <SecretBackendWorkspace
      handle={{ backend: value, session }}
      onFlash={vi.fn()}
    />,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("lists metadata, reads actual notes and exposes read-only file import only on explicit action", async () => {
  const value = backend(true);
  const user = userEvent.setup();
  draw(value);
  expect(value.listItems).not.toHaveBeenCalled();
  expect(value.importToLocal).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "New backend item" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "List backend items" }));
  await screen.findByText("Deployment");
  expect(screen.queryByText("Actual backend notes")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Read notes for Deployment" }),
  );
  expect(await screen.findByLabelText("Backend notes")).toHaveProperty(
    "value",
    "Actual backend notes",
  );
  expect(value.getNotes).toHaveBeenCalledWith("note-one", session);
  await user.click(
    screen.getByRole("button", { name: "Open backend item Deployment" }),
  );
  expect(await screen.findByLabelText("Notes")).toHaveProperty(
    "readOnly",
    true,
  );
  expect(
    screen.queryByRole("button", { name: "Edit backend item" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Delete backend item" }),
  ).toBeNull();
  expect(value.importToLocal).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", {
      name: "Import backend items into local vault",
    }),
  );
  await screen.findByRole("img", { name: "1 items imported; 0 skipped" });
  expect(value.importToLocal).toHaveBeenCalledWith(session);
});

it("creates, reads, updates and confirms deletion through the authenticated backend", async () => {
  const value = backend();
  const user = userEvent.setup();
  draw(value);
  await user.click(screen.getByRole("button", { name: "New backend item" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Item name"));
  await user.type(screen.getByLabelText("Item name"), "Second note");
  await user.type(screen.getByLabelText("Notes"), "Created content");
  await user.click(screen.getByRole("button", { name: "Create backend item" }));
  await screen.findByText("Second note");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "List backend items" }),
  );
  expect(value.createItem).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Second note", notes: "Created content" }),
    session,
  );
  await user.click(
    screen.getByRole("button", { name: "Open backend item Second note" }),
  );
  expect(await screen.findByLabelText("Notes")).toHaveProperty(
    "value",
    "Created content",
  );
  await user.click(screen.getByRole("button", { name: "Edit backend item" }));
  await user.clear(screen.getByLabelText("Notes"));
  await user.type(screen.getByLabelText("Notes"), "Updated content");
  await user.click(screen.getByRole("button", { name: "Update backend item" }));
  await screen.findByRole("img", { name: "Backend item saved" });
  await user.click(
    screen.getByRole("button", { name: "Open backend item Second note" }),
  );
  expect(await screen.findByLabelText("Notes")).toHaveProperty(
    "value",
    "Updated content",
  );
  await user.click(screen.getByRole("button", { name: "Delete backend item" }));
  expect(value.deleteItem).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Confirm delete backend item" }),
  );
  await screen.findByRole("img", { name: "Backend item deleted" });
  expect(value.deleteItem).toHaveBeenCalledWith("note-two", session);
  expect(screen.queryByText("Second note")).toBeNull();
});

it("retains a failed edit for retry and puts the failure on its operation", async () => {
  const value = backend();
  if (!value.createItem) throw new Error("Fixture has no create method");
  vi.mocked(value.createItem).mockRejectedValueOnce(
    new Error("API refused this item"),
  );
  const user = userEvent.setup();
  draw(value);
  await user.click(screen.getByRole("button", { name: "New backend item" }));
  await user.type(screen.getByLabelText("Item name"), "Retry note");
  await user.type(screen.getByLabelText("Notes"), "Retained content");
  await user.click(screen.getByRole("button", { name: "Create backend item" }));
  await screen.findByRole("img", { name: "API refused this item" });
  expect(screen.getByLabelText("Notes")).toHaveProperty(
    "value",
    "Retained content",
  );
  await user.click(screen.getByRole("button", { name: "Create backend item" }));
  await screen.findByText("Retry note");
});

it("offers direct lookup without claiming a browser credential can list or delete its vault", async () => {
  const value = backend();
  value.capabilities.list = false;
  value.capabilities.delete = false;
  const user = userEvent.setup();
  draw(value);
  expect(
    screen.queryByRole("button", { name: "List backend items" }),
  ).toBeNull();
  await user.type(screen.getByLabelText("Item name or ID"), "Deployment");
  await user.click(screen.getByRole("button", { name: "Get backend item" }));
  expect(await screen.findByLabelText("Notes")).toHaveProperty(
    "value",
    "Actual backend notes",
  );
  expect(value.listItems).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Delete backend item" }),
  ).toBeNull();
});

it("derives the new-item form from the backend's supported item kinds", async () => {
  const value = backend();
  value.capabilities.itemKinds = ["secret"];
  const user = userEvent.setup();
  draw(value);
  await user.click(screen.getByRole("button", { name: "New backend item" }));
  expect(screen.getByLabelText("Item type")).toHaveProperty("value", "secret");
  expect(screen.queryByRole("option", { name: "Login" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Note" })).toBeNull();
  await user.type(screen.getByLabelText("Item name"), "API_KEY");
  await user.type(screen.getByLabelText("Secret value"), "private-value");
  await user.click(screen.getByRole("button", { name: "Create backend item" }));
  await screen.findByText("API_KEY");
  expect(value.createItem).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "secret", secret: "private-value" }),
    session,
  );
});

it("composes a browser password form without unsupported website or notes inputs", async () => {
  const value = backend();
  value.capabilities.itemKinds = ["login"];
  value.capabilities.itemFields = ["username", "secret"];
  value.capabilities.list = false;
  value.capabilities.delete = false;
  const user = userEvent.setup();
  draw(value);
  await user.click(screen.getByRole("button", { name: "New backend item" }));
  expect(screen.queryByLabelText("Website")).toBeNull();
  expect(screen.queryByLabelText("Notes")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Get backend notes" }),
  ).toBeNull();
  await user.type(screen.getByLabelText("Item name"), "Origin login");
  await user.type(screen.getByLabelText("Username"), "person");
  await user.type(screen.getByLabelText("Password"), "origin-password");
  await user.click(screen.getByRole("button", { name: "Create backend item" }));
  await screen.findByRole("img", { name: "Backend item saved" });
  expect(value.createItem).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "login",
      username: "person",
      secret: "origin-password",
      notes: "",
      url: "",
    }),
    session,
  );
});
