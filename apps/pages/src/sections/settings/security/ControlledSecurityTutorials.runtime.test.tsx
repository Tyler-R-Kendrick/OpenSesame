/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { kvFlush, kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type PasskeyCeremony,
  unlockMethodsSeams,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { describeGuideGoals } from "@opensesame/app-core/tutorial/registry/goals.js";
import { registerGuidePredicates } from "@opensesame/app-core/tutorial/registry/predicates.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../connector-owner.test-support.js";
import { RetiredCredentialRow } from "./RetiredCredentialRow.js";
const goals = ["vaults.controlled-canaries", "vaults.observation-receiver"];
function offered() {
  registerGuidePredicates();
  return describeGuideGoals("/vault").map((g) => g.id);
}
afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("does not advertise absent owner controls on a genuine new PIN vault", async () => {
  const owner = await persistentBrowserOwner();
  await kvFlush();
  for await (const name of owner.root.keys())
    await owner.root.removeEntry(name);
  kvForgetAll();
  vaultStore.rehydrate();
  await vaultStore.createWithPin("86420379");
  expect(vaultStore.getSnapshot().status).toBe("unlocked");
  const view = render(<RetiredCredentialRow />);
  expect(view.container.innerHTML).toBe("");
  for (const goal of goals) expect(offered()).not.toContain(goal);
});
it("offers both exact controls and tutorials to a genuine one-password owner", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const view = render(<RetiredCredentialRow />);
  expect(
    view.getByRole("button", { name: "Manage controlled canaries" }),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Manage observation receiver" }),
  ).toBeTruthy();
  for (const goal of goals) expect(offered()).toContain(goal);
});

it("offers retained evidence read-only after actual password removal without widening management", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: "controlled-tutorial-retired",
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  await vaultStore.enrollPin("86420379");
  await vaultStore.removePassword();
  const view = render(<RetiredCredentialRow />);
  expect(
    view.getByRole("button", { name: "Manage controlled canaries" }),
  ).toBeTruthy();
  for (const goal of goals) expect(offered()).toContain(goal);
});
it("does not offer owner tutorials when locked, in a real guest, or in an enrolled synthetic realm", async () => {
  const owner = await persistentBrowserOwner();
  for (const goal of goals) expect(offered()).not.toContain(goal);
  await vaultStore.unlock(owner.password);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: "controlled-tutorial-retired",
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  vaultStore.lock();
  await unlockWithRetiredCredentialGate(
    vaultStore,
    "controlled-tutorial-retired",
  );
  expect(vaultStore.getSnapshot().decoy).toBe(true);
  for (const goal of goals) expect(offered()).not.toContain(goal);
  vaultStore.lock();
  await vaultStore.unlock(owner.password);
  vaultStore.lock();
  await vaultStore.createGuest();
  expect(vaultStore.getSnapshot().guest).toBe(true);
  for (const goal of goals) expect(offered()).not.toContain(goal);
});

it("does not advertise absent controls on a genuinely sealed passkey-only vault", async () => {
  const owner = await persistentBrowserOwner();
  await kvFlush();
  for await (const name of owner.root.keys())
    await owner.root.removeEntry(name);
  kvForgetAll();
  vaultStore.rehydrate();
  // Only physical authenticator output is doubled; PRF wrapping, manifest MAC and AES body persist normally.
  vi.spyOn(
    unlockMethodsSeams,
    "createPasskeyUnlockCeremony",
  ).mockImplementation(
    async (): Promise<PasskeyCeremony> => ({
      credential: overlapCast({
        rawId: crypto.getRandomValues(new Uint8Array(16)).buffer,
      }),
      prfOutput: crypto.getRandomValues(new Uint8Array(32)).buffer,
      prfSalt: crypto.getRandomValues(new Uint8Array(16)),
      userId: crypto.getRandomValues(new Uint8Array(16)),
    }),
  );
  await vaultStore.createWithPasskey();
  expect(vaultStore.getSnapshot().header?.unlocks?.passkey).toBeDefined();
  const view = render(<RetiredCredentialRow />);
  expect(view.container.innerHTML).toBe("");
  for (const goal of goals) expect(offered()).not.toContain(goal);
});
