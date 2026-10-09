/** @vitest-environment jsdom */
import { shareReachSeams } from "@opensesame/app-core/lib/local-share-reach.js";
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store-state.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem, manualPassword } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { AccountPasswordRow } from "./AccountPasswordRow.js";
import { ReferenceKeys } from "./ReferenceKeys.js";
import { persistPasswordTestItem } from "./account-password-test-context.js";

afterEach(() => {
  cleanup();
  clearNotices();
  vi.restoreAllMocks();
});
function fixture() {
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
  const state: VaultState = {
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    awaitingSecondStep: false,
    tomb: "personal",
    items: [item],
  };
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => state);
  vi.spyOn(vaultHooksSeams, "useVault").mockImplementation(() => state);
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
  const save = vi
    .spyOn(vaultStore, "saveItem")
    .mockImplementation(async (next) => {
      state.items = persistPasswordTestItem(state.items, next);
    });
  return { item, state, save };
}
it("writes the reference-only template for the item", async () => {
  const { item } = fixture();
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
  const { item } = fixture();
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
  const { item } = fixture();
  item.fields = [];
  const method = item.methods[0];
  if (method?.type !== "password") throw new Error("fixture");
  method.pepper = true;
  render(<ReferenceKeys item={item} />);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Download reference template" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("button")).toBeNull();
});

it("draws nothing while the vault is locked", async () => {
  const { item, state } = fixture();
  const { rerender } = render(<ReferenceKeys item={item} />);
  await screen.findByRole("button", { name: "Download reference template" });
  state.status = "locked";
  rerender(<ReferenceKeys item={item} />);
  expect(screen.queryByRole("button")).toBeNull();
});

function passwordRow(item: ReturnType<typeof fixture>["item"]) {
  const method = item.methods[0];
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
  const { item, save } = fixture();
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
  const { item, save } = fixture();
  save.mockRejectedValue(new Error("PRIVATE_CONTEXT_SENTINEL"));
  const user = userEvent.setup();
  render(passwordRow(item));
  await openUpdate(user);
  await user.type(screen.getByLabelText("New password"), "replacement");
  await user.click(screen.getByRole("button", { name: "Save new value" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(document.body.textContent).not.toContain("PRIVATE_CONTEXT_SENTINEL");
  expect(screen.queryByRole("alert")).toBeNull();
});
