/** @vitest-environment jsdom */
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import * as workflow from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import {
  confirmReference,
  holdReferenceResolution,
  plaintextName,
  referenceOwner,
  referenceSuccessor,
  sentinel,
} from "./ReferenceKeys.authority.fixture.js";
import { ReferenceKeys } from "./ReferenceKeys.js";

afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("withholds prior same-tomb inventory after ordinary owner reauthentication until fresh inventory returns", async () => {
  const owner = await referenceOwner();
  const oldResume = deferred<void>();
  const freshResume = deferred<void>();
  const oldStarted = deferred<void>();
  const freshStarted = deferred<void>();
  const original = workflow.passwordWorkflowInventory;
  const pending = new Set<ReturnType<typeof original>>();
  let first = true;
  let oldPending: ReturnType<typeof original> | undefined;
  vi.spyOn(workflow, "passwordWorkflowInventory").mockImplementation(() => {
    const old = first;
    first = false;
    const result = (async () => {
      const inventory = await original();
      expect(inventory.some((entry) => entry.id === owner.item.id)).toBe(true);
      (old ? oldStarted : freshStarted).finish();
      await (old ? oldResume : freshResume).promise;
      return inventory;
    })();
    if (old) oldPending = result;
    pending.add(result);
    return result;
  });
  render(<ReferenceKeys item={owner.item} />);
  try {
    await oldStarted.promise;
    await act(async () => {
      vaultStore.lock();
      await vaultStore.unlock(owner.password);
    });
    expect(vaultStore.getSnapshot()).toMatchObject({
      status: "unlocked",
      tomb: "personal",
      decoy: false,
    });
    await act(async () => {
      oldResume.finish();
      await oldPending;
    });
    // The original component publishes this retained inventory immediately.
    // Assert that directly before waiting for any fresh request to complete.
    expect(
      screen.queryByRole("button", { name: "Download reference template" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: plaintextName })).toBeNull();
    expect(JSON.stringify(listNotices())).not.toContain(sentinel);
    await freshStarted.promise;
    await act(async () => {
      freshResume.finish();
      await Promise.all(pending);
    });
    const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
    await confirmReference();
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0]).toEqual([
      "plaintext.env",
      owner.expected,
      "text/plain",
    ]);
  } finally {
    oldResume.finish();
    freshResume.finish();
    await Promise.allSettled(pending);
  }
});

it("withholds completed plaintext after ordinary same-tomb owner reauthentication and accepts fresh consent", async () => {
  const owner = await referenceOwner();
  const held = holdReferenceResolution();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  render(<ReferenceKeys item={owner.item} />);
  try {
    await confirmReference();
    await held.started;
    await act(async () => {
      vaultStore.lock();
      await vaultStore.unlock(owner.password);
    });
    await act(async () => {
      await held.release();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(sentinel);
    expect(JSON.stringify(listNotices())).not.toContain(sentinel);
    await confirmReference();
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0]).toEqual([
      "plaintext.env",
      owner.expected,
      "text/plain",
    ]);
  } finally {
    await held.release();
  }
});

it("retires visible inventory across synthetic recovery and waits for a genuinely fresh owner inventory", async () => {
  const owner = await referenceOwner();
  const freshResume = deferred<void>();
  const freshStarted = deferred<void>();
  const original = workflow.passwordWorkflowInventory;
  const pending = new Set<ReturnType<typeof original>>();
  let first = true;
  let freshRequests = 0;
  vi.spyOn(workflow, "passwordWorkflowInventory").mockImplementation(() => {
    const old = first;
    first = false;
    const state = vaultStore.getSnapshot();
    if (
      !old &&
      state.status === "unlocked" &&
      !state.decoy &&
      state.items.some((entry) => entry.id === owner.item.id)
    )
      freshRequests += 1;
    const result = (async () => {
      const inventory = await original();
      if (!old) {
        freshStarted.finish();
        await freshResume.promise;
      }
      return inventory;
    })();
    pending.add(result);
    return result;
  });
  render(<ReferenceKeys item={owner.item} />);
  try {
    await screen.findByRole("button", { name: "Download reference template" });
    await referenceSuccessor(owner.password);
    expect(
      screen.queryByRole("button", { name: "Download reference template" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: plaintextName })).toBeNull();
    // The public unlock and its React effects have completed. Observe an actual
    // fresh-owner request before waiting for the crypto result it will produce.
    expect(freshRequests).toBeGreaterThan(0);
    await freshStarted.promise;
    await act(async () => {
      freshResume.finish();
      await Promise.all(pending);
    });
    const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
    await confirmReference();
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0]).toEqual([
      "plaintext.env",
      owner.expected,
      "text/plain",
    ]);
    expect(JSON.stringify(listNotices())).not.toContain(sentinel);
  } finally {
    freshResume.finish();
    await Promise.allSettled(pending);
  }
});
