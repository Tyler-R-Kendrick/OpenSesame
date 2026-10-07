/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem, manualPassword } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { AccountPasswordRow } from "./AccountPasswordRow.js";
import { ReferenceKeys } from "./ReferenceKeys.js";

afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const item = createItem("account", "Example");
  item.methods = [
    manualPassword(
      "password-primary",
      "PRIVATE_CONTEXT_SENTINEL",
      "2020-01-01T00:00:00Z",
    ),
  ];
  item.username = "unchanged";
  item.fields = [
    {
      id: "extra",
      name: "Extra",
      hidden: true,
      value: "CUSTOM_PRIVATE_SENTINEL",
    },
  ];
  item.updatedAt = "2020-01-01T00:00:00Z";
  item.uris = [
    {
      id: "uri_fixture",
      uri: "https://user:pass@example.test/reset/PATH_SENTINEL?token=QUERY_SENTINEL",
      match: "domain",
    },
  ];
  await vaultStore.addItems([item]);
  // Observe the actual sealed writer. Only a deliberately failed write is
  // substituted in its dedicated failure-presentation case.
  const save = vi.spyOn(vaultStore, "saveItem");
  return { item, save, password: owner.password };
}
it("writes the reference-only template for the item", async () => {
  const { item } = await fixture();
  const download = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const user = userEvent.setup();
  render(<ReferenceKeys item={item} />);
  await screen.findByRole("button", { name: "Download reference template" });
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
  expect(document.body.textContent).not.toContain("CUSTOM_PRIVATE_SENTINEL");
  await user.click(
    screen.getByRole("button", { name: "Download reference template" }),
  );
  expect(download).toHaveBeenCalledTimes(1);
  const [name, text, type] = download.mock.calls[0] ?? [];
  expect([name, type]).toEqual(["references.env.tpl", "text/plain"]);
  expect(text).toContain(
    `EXAMPLE_PASSWORD=os://personal/${item.id}/method%3Apassword-primary%3Asecret`,
  );
  expect(text).not.toContain("PRIVATE_CONTEXT_SENTINEL");
});

it("asks twice before a plaintext environment file, and writes it only the second time", async () => {
  const { item } = await fixture();
  const download = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const user = userEvent.setup();
  render(<ReferenceKeys item={item} />);
  const first = await screen.findByRole("button", {
    name: "Download plaintext .env",
  });
  await user.click(first);
  expect(download).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", {
      name: "Really download a plaintext .env? Press again to confirm",
    }),
  );
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  const [name, text] = download.mock.calls[0] ?? [];
  expect(name).toBe("plaintext.env");
  expect(text).toContain('EXAMPLE_PASSWORD="PRIVATE_CONTEXT_SENTINEL"');
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
});

it("draws no group, and no failure, for an item with nothing to reference", async () => {
  const { item } = await fixture();
  item.fields = [];
  const method = item.methods[0];
  if (method?.type !== "password") throw new Error("fixture");
  method.pepper = true;
  await vaultStore.replaceAll([item], []);
  render(<ReferenceKeys item={item} />);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Download reference template" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("button")).toBeNull();
});

it("draws nothing while the vault is locked", async () => {
  const { item } = await fixture();
  const { rerender } = render(<ReferenceKeys item={item} />);
  await screen.findByRole("button", { name: "Download reference template" });
  act(() => vaultStore.lock());
  rerender(<ReferenceKeys item={item} />);
  expect(screen.queryByRole("button")).toBeNull();
});

function passwordRow(
  item: Awaited<ReturnType<typeof fixture>>["item"],
  index = 0,
) {
  const method = item.methods[index];
  if (method?.type !== "password") throw new Error("fixture");
  return (
    <AccountPasswordRow
      item={item}
      method={method}
      title="Password"
      guide
      copying={{ copied: null, failed: null, copy: async () => {} }}
      onSave={async (next) => {
        await vaultStore.saveItem({
          ...item,
          methods: item.methods.map((m) => (m.id === next.id ? next : m)),
        });
      }}
    />
  );
}

async function openUpdate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Update password" }));
  await user.click(screen.getByRole("button", { name: "Enter" }));
}

it("compares a typed password with the saved one by a mark, writing nothing", async () => {
  const { item, save } = await fixture();
  const user = userEvent.setup();
  render(passwordRow(item));
  await openUpdate(user);
  const field = screen.getByLabelText("New password");
  await user.type(field, "not-the-saved-one");
  await user.click(
    screen.getByRole("button", { name: "Compare with the saved password" }),
  );
  await screen.findByRole("img", { name: "Differs from the saved password" });
  await user.clear(field);
  await user.type(field, "PRIVATE_CONTEXT_SENTINEL");
  expect(screen.queryByRole("img", { name: /saved password/ })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Compare with the saved password" }),
  );
  await screen.findByRole("img", { name: "Same as the saved password" });
  expect(save).not.toHaveBeenCalled();
});

it("updates the selected method through the verified write and suppresses an uncertain one's cause", async () => {
  const { item, save } = await fixture();
  save.mockRejectedValue(new Error("PRIVATE_CONTEXT_SENTINEL"));
  const user = userEvent.setup();
  render(passwordRow(item));
  await openUpdate(user);
  await user.type(screen.getByLabelText("New password"), "replacement");
  await user.click(screen.getByRole("button", { name: "Save new value" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      listNotices().some(
        (notice) =>
          notice.id ===
          `vault:secret-update:${item.id}:password-primary:password`,
      ),
    ).toBe(true),
  );
  expect(JSON.stringify(listNotices())).not.toContain(
    "PRIVATE_CONTEXT_SENTINEL",
  );
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("persists only the selected secondary password and preserves primary and protected siblings", async () => {
  const { item, save, password } = await fixture();
  const secondary = manualPassword(
    "password-secondary",
    "SECONDARY_PRIVATE_SENTINEL",
    item.createdAt,
  );
  const protectedMethod = {
    ...manualPassword(
      "password-protected",
      "PROTECTED_PRIVATE_SENTINEL",
      item.createdAt,
    ),
    pepper: true,
  };
  item.methods.push(secondary, protectedMethod);
  await vaultStore.replaceAll([item], []);
  const primary = structuredClone(item.methods[0]);
  const protectedSibling = structuredClone(item.methods[2]);
  const user = userEvent.setup();
  render(passwordRow(item, 1));
  await openUpdate(user);
  await user.type(
    screen.getByLabelText("New password"),
    "replacement-private-password",
  );
  await user.click(screen.getByRole("button", { name: "Save new value" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const written = save.mock.results[0];
  if (written?.type !== "return")
    throw new Error("Expected actual sealed write.");
  await written.value;
  await waitFor(() =>
    expect(screen.queryByLabelText("New password")).toBeNull(),
  );
  expect(document.body.textContent).not.toContain(
    "replacement-private-password",
  );
  expect(document.body.textContent).not.toContain("SECONDARY_PRIVATE_SENTINEL");
  expect(document.body.textContent).not.toContain("PROTECTED_PRIVATE_SENTINEL");
  cleanup();
  // Read the persisted ciphertext in a freshly authenticated owner session.
  vaultStore.lock();
  await vaultStore.unlock(password);
  const saved = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.id === item.id);
  if (saved?.kind !== "account") throw new Error("Expected persisted account.");
  expect(saved.methods).toHaveLength(3);
  expect(saved.methods[0]).toEqual(primary);
  expect(saved.methods[1]).toMatchObject({
    id: secondary.id,
    secret: "replacement-private-password",
  });
  expect(saved.methods[2]).toEqual(protectedSibling);
  expect(saved.fields).toEqual(item.fields);
  expect(saved.username).toBe(item.username);
});
