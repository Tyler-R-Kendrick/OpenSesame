import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import * as workflows from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem, manualPassword } from "@opensesame/vault-core";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { UpdateSecretPanel } from "./SecretUpdate.js";

export async function passwordRowOwner(synthetic: boolean) {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const item = createItem("account", "Controlled owner password row");
  const selected = `${item.id}:secondary`;
  item.methods = [
    manualPassword(
      `${item.id}:primary`,
      "protected-primary-value",
      item.updatedAt,
    ),
    manualPassword(selected, "controlled-secondary-value", item.updatedAt),
  ];
  item.fields = [
    {
      id: "private-note",
      name: "Private",
      hidden: true,
      value: "protected-custom-value",
    },
  ];
  await vaultStore.addItems([item]);
  const retired = "controlled-retired-password-row";
  if (synthetic)
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: owner.password,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
  return {
    ...owner,
    item,
    selected,
    async recover() {
      await act(async () => {
        vaultStore.lock();
        if (synthetic) {
          await unlockWithRetiredCredentialGate(vaultStore, retired);
          expect(vaultStore.getSnapshot().decoy).toBe(true);
          expect(
            vaultStore
              .getSnapshot()
              .items.some((entry) => entry.id === item.id),
          ).toBe(false);
          vaultStore.lock();
        }
        await vaultStore.unlock(owner.password);
      });
      expect(vaultStore.getSnapshot()).toMatchObject({
        status: "unlocked",
        decoy: false,
      });
    },
  };
}

/** Hold only a completed production operation; all authentication and crypto remain genuine. */
export function holdPasswordOperation(
  f: Awaited<ReturnType<typeof passwordRowOwner>>,
  apply: boolean,
) {
  const ready = deferred<void>();
  const resume = deferred<void>();
  let once = true;
  let work: Promise<boolean> | undefined;
  const operation = (candidate: string): Promise<boolean> => {
    work = (async () => {
      const result = await workflows.comparePrivatePassword(
        f.item.id,
        candidate,
        apply,
        f.selected,
      );
      if (once) {
        once = false;
        ready.finish();
        await resume.promise;
      }
      return result.matches;
    })();
    return work;
  };
  return {
    ready: ready.promise,
    operation,
    release: () => resume.finish(),
    async drain() {
      resume.finish();
      await work;
    },
  };
}

export function renderPasswordRow(
  compare: (candidate: string) => Promise<boolean>,
  onUpdate: (candidate: string) => Promise<void>,
) {
  return render(
    <UpdateSecretPanel
      itemId="controlled-owner-row"
      label="password"
      compare={compare}
      onUpdate={onUpdate}
    />,
  );
}
export async function enterPasswordRow(value: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Update password" }));
  await user.click(screen.getByRole("button", { name: "Enter" }));
  await user.type(screen.getByLabelText("New password"), value);
  return user;
}

export function holdBrowserFailure(
  f: Awaited<ReturnType<typeof passwordRowOwner>>,
) {
  const ready = deferred<void>();
  const resume = deferred<void>();
  let work: Promise<void> | undefined;
  return {
    ready: ready.promise,
    operation(value: string) {
      work = (async () => {
        await workflows.comparePrivatePassword(
          f.item.id,
          value,
          false,
          f.selected,
        );
        let failure: unknown;
        try {
          await f.root.getFileHandle("controlled-missing-private-file");
        } catch (caught) {
          failure = caught;
        }
        if (!failure)
          throw new Error("Expected actual missing browser file failure.");
        ready.finish();
        await resume.promise;
        throw failure;
      })();
      return work;
    },
    async drain() {
      resume.finish();
      await work?.catch(() => {});
    },
  };
}
