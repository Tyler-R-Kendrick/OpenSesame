/** @vitest-environment jsdom */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { AccountItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitConnectorOwner,
  releaseConnectorOwner,
} from "../settings/connector-owner.test-support.js";
import { ItemDetail } from "./ItemDetail.js";
import { makeAccount } from "./account.test-support.js";

async function renderAccount(account: AccountItem) {
  await vaultStore.replaceAll([account], []);
  return render(
    <MemoryRouter initialEntries={[`/vault/${account.id}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await admitConnectorOwner();
});

afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
});

describe("account edit timestamps", () => {
  it.each([
    "2026-08-02T12:00:00Z",
    "2026-08-02T14:00:00+02:00",
    "2026-08-02T12:00:30Z",
  ])("shows a shared edit timestamp once (%s)", async (passwordChangedAt) => {
    await renderAccount(
      makeAccount({
        id: "itm_dates",
        updatedAt: "2026-08-02T12:00:00Z",
        passwordChangedAt,
      }),
    );
    expect(screen.getAllByText(/^Updated /)).toHaveLength(1);
    expect(screen.queryByText(/^Password last changed /)).toBeNull();
  });

  it("retains password history when another edit updated the item later", async () => {
    await renderAccount(makeAccount({ id: "itm_dates" }));
    expect(screen.getAllByText(/^Updated /)).toHaveLength(1);
    expect(screen.getByText(/^Password last changed /)).toBeTruthy();
  });

  it("shows only the item edit date for an account without a password", async () => {
    await renderAccount(makeAccount({ id: "itm_dates", password: "" }));
    expect(screen.getAllByText(/^Updated /)).toHaveLength(1);
    expect(screen.queryByText(/^Password last changed /)).toBeNull();
  });
});
