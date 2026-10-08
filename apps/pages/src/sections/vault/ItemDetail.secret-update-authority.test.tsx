/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { ItemDetail } from "./ItemDetail.js";

afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("updates a secret value through the update panel and reopens its persisted ciphertext", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const secret = createItem("secret", "Deploy hook");
  secret.value = "whsec_123";
  await vaultStore.addItems([secret]);
  const saved = vi.spyOn(vaultStore, "saveItem");
  render(
    <MemoryRouter initialEntries={[`/vault/${secret.id}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Update secret/i }));
  await userEvent.click(
    screen.getByRole("button", { name: /Save new value/i }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  const result = saved.mock.results[0];
  if (result?.type !== "return")
    throw new Error("Expected actual sealed write.");
  await result.value;
  const written = saved.mock.calls[0]?.[0];
  if (written?.kind !== "secret") throw new Error("Expected updated secret.");
  expect(written.value).not.toBe("whsec_123");
  expect(written.value).not.toBe("");
  cleanup();
  vaultStore.lock();
  await vaultStore.unlock(owner.password);
  const reopened = vaultStore
    .getSnapshot()
    .items.find((item) => item.id === secret.id);
  expect(reopened).toMatchObject({
    kind: "secret",
    id: secret.id,
    name: secret.name,
    value: written.value,
    fields: secret.fields,
    grantees: secret.grantees,
    ceiling: secret.ceiling,
    connectionRef: secret.connectionRef,
  });
});
