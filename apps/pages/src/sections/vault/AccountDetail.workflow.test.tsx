/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  itemText,
  withdrawFromBody,
} from "@opensesame/app-core/lib/vault/item-departure.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type VaultItem,
  emptyBody,
  passwordMethod,
} from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitConnectorOwner,
  releaseConnectorOwner,
} from "../settings/connector-owner.test-support.js";
import { AccountDetail } from "./AccountDetail.js";
import { makeAccount } from "./account.test-support.js";

type AccountView = { current: { items: VaultItem[] } };
const vault: AccountView = { current: { items: [] } };
const store = { saveItem: vi.fn<(item: VaultItem) => Promise<void>>() };
async function renderAt(id: string) {
  await vaultStore.replaceAll(vault.current.items, []);
  const item = vault.current.items.find((entry) => entry.id === id);
  if (item?.kind !== "account") throw new Error("Expected account fixture.");
  return render(
    <MemoryRouter>
      <AccountDetail
        item={item}
        revealed={new Set()}
        toggle={() => {}}
        copied={null}
        failed={null}
        copy={async () => {}}
      />
    </MemoryRouter>,
  );
}
beforeEach(async () => {
  await admitConnectorOwner();
  vault.current.items = [];
  store.saveItem = vi.spyOn(vaultStore, "saveItem");
});
afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
});
describe("account password workflow boundary", () => {
  it("suppresses private persistence errors from the account password update without retry", async () => {
    const account = makeAccount({
      id: "itm_private_failure",
      password: "old-password",
    });
    vault.current = { items: [account] };
    store.saveItem.mockRejectedValue(
      new Error("PRIVATE_PASSWORD_PERSISTENCE_SENTINEL"),
    );
    await renderAt(account.id);
    await userEvent.click(
      screen.getByRole("button", { name: "Update password" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await userEvent.type(
      screen.getByPlaceholderText("New password"),
      "candidate-private-password",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save new value" }),
    );
    await waitFor(() =>
      expect(
        listNotices().some((notice) => notice.body.includes("unverified")),
      ).toBe(true),
    );
    expect(JSON.stringify(listNotices())).not.toContain(
      "PRIVATE_PASSWORD_PERSISTENCE_SENTINEL",
    );
    expect(document.body.textContent).not.toContain(
      "PRIVATE_PASSWORD_PERSISTENCE_SENTINEL",
    );
    expect(document.body.textContent).not.toContain(
      "candidate-private-password",
    );
    expect(store.saveItem).toHaveBeenCalledTimes(1);
    expect(passwordMethod(account)?.secret).toBe("old-password");
  });
  it("refuses to recreate an account withdrawn while its private password editor is open", async () => {
    const account = makeAccount({
      id: "withdrawn-account",
      password: "original-password",
    });
    vault.current = { items: [account] };
    await renderAt(account.id);
    await userEvent.click(
      screen.getByRole("button", { name: "Update password" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await userEvent.type(
      screen.getByLabelText("New password"),
      "PRIVATE_WITHDRAWN_CANDIDATE",
    );
    const body = { ...emptyBody(), items: [account] };
    withdrawFromBody(body, {
      items: { [account.id]: itemText(account) },
      folderIds: [],
    });
    await vaultStore.replaceAll(body.items, []);
    await userEvent.click(
      screen.getByRole("button", { name: "Save new value" }),
    );
    await waitFor(() =>
      expect(
        listNotices().some((notice) => notice.body.includes("unverified")),
      ).toBe(true),
    );
    expect(JSON.stringify(listNotices())).not.toContain(
      "PRIVATE_WITHDRAWN_CANDIDATE",
    );
    expect(store.saveItem).not.toHaveBeenCalled();
    expect(body.items).toEqual([]);
    expect(passwordMethod(account)?.secret).toBe("original-password");
  }, 20_000);
});
