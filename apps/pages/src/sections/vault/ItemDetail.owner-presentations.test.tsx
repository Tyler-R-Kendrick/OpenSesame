/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem, manualPassword } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { ItemDetail } from "./ItemDetail.js";
import { makeAccount } from "./account.test-support.js";

afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAt(itemId: string) {
  return render(
    <MemoryRouter initialEntries={[`/vault/${itemId}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

it("renders a secret value and its grantees", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const secret = createItem("secret", "Deploy hook");
  secret.value = "whsec_123";
  secret.ceiling = [{ id: "g1", action: "http.post", resource: "hook/x" }];
  secret.grantees = ["agt_release_bot"];
  secret.connectionRef = "conn/github/pat";
  await vaultStore.addItems([secret]);
  const listConnections = vi.spyOn(connectionSeams, "listConnections");
  renderAt(secret.id);
  expect(screen.getByRole("heading", { name: "Value" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Grantees" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Secret" })).toBeNull();
  const row = screen.getByRole("button", {
    name: "Reveal secret value",
  }).parentElement;
  expect(row?.querySelectorAll("button").length).toBe(3);
  expect(screen.getByText("agt_release_bot")).toBeTruthy();
  expect(
    screen.queryByText(/Capability ceiling|http\.post|hook\/x/),
  ).toBeNull();
  expect(screen.queryByText("Connection reference")).toBeNull();
  expect(screen.queryByRole("link", { name: /^Grant or invoke$/i })).toBeNull();
  expect(listConnections).not.toHaveBeenCalled();
  expect(screen.queryByText("whsec_123")).toBeNull();
});

it("renders an untitled account without username or password", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const account = makeAccount({
    id: "itm_login",
    name: "",
    username: "",
    methods: [manualPassword("itm_login:password", "", "2026-08-01T00:00:00Z")],
  });
  await vaultStore.addItems([
    account,
    makeAccount({ id: "itm_other", name: "Other" }),
  ]);
  renderAt(account.id);
  expect(screen.getByRole("heading", { name: "Untitled" })).toBeTruthy();
  // No username row, and the update affordance stands alone.
  expect(screen.queryByText("Username / ID")).toBeNull();
  expect(screen.getByRole("button", { name: /Update password/i })).toBeTruthy();
  expect(screen.queryByText("Authenticator code")).toBeNull();
});
