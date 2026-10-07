/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import * as patterns from "@opensesame/app-core/lib/vault/website-pattern.js";
import { createItem } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { ItemEditor } from "./ItemEditor.js";

let revokeKinds = () => {};
beforeAll(() => {
  revokeKinds = registerLegacyItemKinds();
});
afterAll(() => revokeKinds());
afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
});

it("refuses an original owner's held account save after actual synthetic entry and fresh owner recovery", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const account = createItem("account", "Controlled account");
  account.username = "original-owner";
  await vaultStore.addItems([account]);
  const original = vaultStore
    .getSnapshot()
    .items.find((item) => item.id === account.id);
  if (original?.kind !== "account")
    throw new Error("Expected persisted owner account.");
  const retired = "controlled-retired-editor-owner";
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  let entered = false;
  const resume = deferred<void>();
  const validate = patterns.validateWebsitePatterns;
  let work: Promise<void> | undefined;
  vi.spyOn(patterns, "validateWebsitePatterns").mockImplementation((uris) => {
    work = (async () => {
      await validate(uris);
      entered = true;
      await resume.promise;
    })();
    return work;
  });
  const save = vi.spyOn(vaultStore, "saveItem");
  render(
    <MemoryRouter initialEntries={[`/vault/${account.id}/edit`]}>
      <Routes>
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="/vault/:itemId" element={<div>saved destination</div>} />
      </Routes>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  try {
    await user.clear(screen.getByLabelText("Username / ID"));
    await user.type(
      screen.getByLabelText("Username / ID"),
      "held-original-intent",
    );
    await user.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(entered).toBe(true));
    await act(async () => {
      vaultStore.lock();
      await unlockWithRetiredCredentialGate(vaultStore, retired);
    });
    expect(vaultStore.getSnapshot().decoy).toBe(true);
    expect(
      vaultStore.getSnapshot().rawItems?.some((item) => item.id === account.id),
    ).toBe(false);
    await act(async () => {
      vaultStore.lock();
      await vaultStore.unlock(owner.password);
    });
    resume.finish();
    await act(async () => {
      await work;
    });
    await waitFor(() => {
      const ready = screen.queryByRole("button", { name: "Save item" });
      expect(
        (ready !== null && !ready.hasAttribute("disabled")) ||
          screen.queryByText("saved destination") !== null,
      ).toBe(true);
    });
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText("saved destination")).toBeNull();
    expect(
      vaultStore.getSnapshot().items.find((item) => item.id === account.id),
    ).toMatchObject({
      username: "original-owner",
      updatedAt: original.updatedAt,
    });
    expect(document.body.textContent).not.toContain("held-original-intent");
    await user.clear(screen.getByLabelText("Username / ID"));
    await user.type(
      screen.getByLabelText("Username / ID"),
      "fresh-owner-intent",
    );
    await user.click(screen.getByRole("button", { name: "Save item" }));
    await screen.findByText("saved destination");
    expect(save).toHaveBeenCalledTimes(1);
    const result = save.mock.results[0];
    if (result?.type !== "return")
      throw new Error("Expected fresh actual save.");
    await result.value;
    expect(
      vaultStore.getSnapshot().items.find((item) => item.id === account.id),
    ).toMatchObject({ username: "fresh-owner-intent" });
  } finally {
    resume.finish();
    await work;
  }
});
