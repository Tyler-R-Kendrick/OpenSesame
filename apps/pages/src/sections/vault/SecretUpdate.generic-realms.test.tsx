/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { readSealedFile } from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";
import { updateItemSecret } from "./item-secret-update.js";

afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const synthetic of [false, true]) {
  it(`allows a generic ${synthetic ? "enrolled synthetic" : "public guest"} secret edit while keeping real ciphertext unchanged`, async () => {
    const owner = await persistentBrowserOwner();
    await vaultStore.unlock(owner.password);
    const real = createItem("secret", "Production owner item");
    real.value = "REAL_GENERIC_REALM_PRIVATE_SENTINEL";
    await vaultStore.addItems([real]);
    const retired = "generic-realm-retired-password";
    if (synthetic) {
      await enrollRetiredCredential({
        tomb: "personal",
        currentPassword: owner.password,
        retiredPassword: retired,
        response: "synthetic_decoy",
        acknowledgePasswordVerifierRisk: true,
      });
    }
    const ownerCiphertext = readSealedFile("personal", "body");
    expect(ownerCiphertext).not.toBeNull();
    vaultStore.lock();
    if (synthetic) await unlockWithRetiredCredentialGate(vaultStore, retired);
    else await vaultStore.createGuest();
    expect(vaultStore.getSnapshot()).toMatchObject({ status: "unlocked" });
    expect(vaultStore.getSnapshot().decoy).toBe(synthetic);
    expect(
      vaultStore.getSnapshot().items.some((item) => item.id === real.id),
    ).toBe(false);
    const scratch = createItem("secret", "Realm scratch item");
    scratch.value = "initial-scratch-value";
    await vaultStore.addItems([scratch]);
    const save = vi.spyOn(vaultStore, "saveItem");
    render(
      <UpdateSecretPanel
        itemId={scratch.id}
        label="secret"
        onUpdate={(value) =>
          updateItemSecret(scratch, value, (next) => vaultStore.saveItem(next))
        }
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Update secret" }));
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await user.type(
      screen.getByLabelText("New secret"),
      "updated-scratch-value",
    );
    await user.click(screen.getByRole("button", { name: "Save new value" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const written = save.mock.results[0];
    if (written?.type !== "return")
      throw new Error("Expected genuine scratch write.");
    await act(async () => {
      await written.value;
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("New secret")).toBeNull(),
    );
    expect(
      vaultStore.getSnapshot().items.find((item) => item.id === scratch.id),
    ).toMatchObject({ value: "updated-scratch-value" });
    expect(readSealedFile("personal", "body")).toEqual(ownerCiphertext);
    expect(listNotices()).toEqual([]);
    act(() => vaultStore.lock());
    expect(vaultStore.isUnlocked()).toBe(false);
    expect(screen.queryByRole("button", { name: "Update secret" })).toBeNull();
    await act(async () => {
      vaultStore.loadActiveProjectScope();
      await vaultStore.unlock(owner.password);
    });
    expect(vaultStore.getSnapshot()).toMatchObject({
      tomb: "personal",
      decoy: false,
      guest: false,
    });
    expect(
      vaultStore.getSnapshot().items.find((item) => item.id === real.id),
    ).toMatchObject({ value: real.value });
    expect(
      vaultStore.getSnapshot().items.some((item) => item.id === scratch.id),
    ).toBe(false);
    expect(readSealedFile("personal", "body")).toEqual(ownerCiphertext);
    expect(save).toHaveBeenCalledTimes(1);
  });
}
