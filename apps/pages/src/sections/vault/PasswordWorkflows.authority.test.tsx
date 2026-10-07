/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import * as workflow from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { PasswordWorkflowsPanel } from "./PasswordWorkflows.js";

afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function owner() {
  const fixture = await persistentBrowserOwner();
  await vaultStore.unlock(fixture.password);
  const item = createItem("secret", "Original owner example");
  item.value = "controlled-private-fixture";
  await vaultStore.addItems([item]);
  return { ...fixture, item };
}
it("does not redisplay an original owner's result after an actual synthetic realm and fresh owner recovery", async () => {
  const f = await owner();
  const retired = "controlled-retired-workflow-fixture";
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: f.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const user = userEvent.setup();
  render(<PasswordWorkflowsPanel />);
  await user.click(screen.getByRole("button", { name: "Inventory" }));
  expect(
    (await screen.findByLabelText("Workflow result")).textContent,
  ).toContain(f.item.name);
  await act(async () => {
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
  });
  expect(vaultStore.getSnapshot().decoy).toBe(true);
  expect(screen.queryByLabelText("Workflow result")).toBeNull();
  expect(screen.queryByLabelText("Private credential")).toBeNull();
  await act(async () => {
    vaultStore.lock();
    await vaultStore.unlock(f.password);
  });
  expect(
    vaultStore.getSnapshot().items.some((item) => item.id === f.item.id),
  ).toBe(true);
  expect(screen.queryByLabelText("Workflow result")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Inventory" }));
  expect(
    (await screen.findByLabelText("Workflow result")).textContent,
  ).toContain(f.item.name);
});
it("refuses an already resolved genuine private value before download after same-vault fresh authentication", async () => {
  const f = await owner();
  const resume = deferred<void>();
  let started = false;
  let work: Promise<string> | undefined;
  const resolve = workflow.resolveLocalReference;
  vi.spyOn(workflow, "resolveLocalReference").mockImplementation(
    (reference) => {
      work = (async () => {
        const value = await resolve(reference);
        started = true;
        await resume.promise;
        return value;
      })();
      return work;
    },
  );
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const user = userEvent.setup();
  render(<PasswordWorkflowsPanel />);
  try {
    await user.type(
      screen.getByLabelText("Local secret reference"),
      `os://personal/${f.item.id}/value`,
    );
    await user.click(
      screen.getByLabelText("I want this credential in a plaintext file."),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Read and download plaintext credential",
      }),
    );
    await waitFor(() => expect(started).toBe(true));
    await act(async () => {
      vaultStore.lock();
      await vaultStore.unlock(f.password);
    });
    resume.finish();
    await act(async () => {
      await work;
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", {
            name: "Read and download plaintext credential",
          })
          .closest("fieldset")?.disabled,
      ).toBe(false),
    );
    expect(saved).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(f.item.value);
    expect(screen.queryByLabelText("Workflow result")).toBeNull();
  } finally {
    resume.finish();
    await work;
  }
});
