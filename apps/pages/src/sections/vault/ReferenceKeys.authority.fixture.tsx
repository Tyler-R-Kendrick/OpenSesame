import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { itemEnvTemplate } from "@opensesame/app-core/lib/vault/item-references.js";
import * as workflow from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";

export const sentinel = "GENUINE_REFERENCE_OWNER_PRIVATE_SENTINEL";
export const plaintextName = "Download plaintext .env";
export const confirmationName =
  "Really download a plaintext .env? Press again to confirm";
const retired = "reference-key-retired-fixture";

/** Physical storage APIs alone are doubled; root admission and crypto are genuine. */
export async function referenceOwner() {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const item = createItem("secret", "Owner reference");
  item.value = sentinel;
  await vaultStore.addItems([item]);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const inventory = (await workflow.passwordWorkflowInventory()).find(
    (entry) => entry.id === item.id,
  );
  if (!inventory) throw new Error("Expected genuinely admitted inventory");
  const template = itemEnvTemplate(
    item.name,
    inventory.fields.flatMap((field) =>
      field.ref ? [{ label: field.label, ref: field.ref }] : [],
    ),
  );
  const expected = await workflow.resolveLocalEnvTemplate(template);
  expect(expected.count).toBe(1);
  expect(expected.content).toContain(sentinel);
  return { ...owner, item, expected: expected.content };
}

export async function referenceSuccessor(password: string) {
  await act(async () => {
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
  });
  expect(vaultStore.getSnapshot().decoy).toBe(true);
  expect(screen.queryByRole("button", { name: plaintextName })).toBeNull();
  await act(async () => {
    vaultStore.lock();
    await vaultStore.unlock(password);
  });
}

export async function confirmReference() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: plaintextName }));
  await user.click(screen.getByRole("button", { name: confirmationName }));
}

/** Hold only a completed production result, never the resolver's verdict. */
export function holdReferenceResolution() {
  const resume = deferred<void>();
  const started = deferred<void>();
  const original = workflow.resolveLocalEnvTemplate;
  let held: ReturnType<typeof original> | undefined;
  let first = true;
  vi.spyOn(workflow, "resolveLocalEnvTemplate").mockImplementation((text) => {
    if (!first) return original(text);
    first = false;
    held = (async () => {
      const result = await original(text);
      started.finish();
      await resume.promise;
      return result;
    })();
    return held;
  });
  return {
    started: started.promise,
    release: async () => {
      resume.finish();
      await held;
    },
  };
}
