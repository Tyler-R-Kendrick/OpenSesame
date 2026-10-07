/** @vitest-environment jsdom */
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import * as workflow from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import {
  confirmReference,
  confirmationName,
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

it("withholds completed owner plaintext after retired entry and accepts a fresh owner intent", async () => {
  const owner = await referenceOwner();
  const held = holdReferenceResolution();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  render(<ReferenceKeys item={owner.item} />);
  try {
    await confirmReference();
    await held.started;
    await referenceSuccessor(owner.password);
    await act(async () => {
      await held.release();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(sentinel);
    expect(JSON.stringify(listNotices())).not.toContain(sentinel);
    expect(JSON.stringify(listNotices())).not.toContain(
      "The environment file could not be written.",
    );
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

it("admits fresh inventory only after its own completed return, never a retained predecessor", async () => {
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
    await referenceSuccessor(owner.password);
    await act(async () => {
      oldResume.finish();
      await oldPending;
    });
    expect(
      screen.queryByRole("button", { name: "Download reference template" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: plaintextName })).toBeNull();
    expect(document.body.textContent).not.toContain(sentinel);
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

it("requires two new presses after ordinary same-vault owner reauthentication", async () => {
  const owner = await referenceOwner();
  const user = userEvent.setup();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  render(<ReferenceKeys item={owner.item} />);
  await user.click(await screen.findByRole("button", { name: plaintextName }));
  expect(screen.getByRole("button", { name: confirmationName })).toBeDefined();
  await act(async () => {
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
  });
  await user.click(await screen.findByRole("button", { name: plaintextName }));
  expect(saved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: confirmationName }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]).toEqual([
    "plaintext.env",
    owner.expected,
    "text/plain",
  ]);
});

it("withholds completed plaintext when its item is removed before dispatch", async () => {
  const owner = await referenceOwner();
  const held = holdReferenceResolution();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  render(<ReferenceKeys item={owner.item} />);
  try {
    await confirmReference();
    await held.started;
    await act(async () => {
      await vaultStore.trashItem(owner.item.id);
    });
    expect(
      screen.queryByRole("button", { name: "Download reference template" }),
    ).toBeNull();
    await act(async () => {
      await held.release();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(JSON.stringify(listNotices())).not.toContain(
      "The environment file could not be written.",
    );
  } finally {
    await held.release();
  }
});

it("retires completed plaintext when the toolbar changes items within the same owner session", async () => {
  const owner = await referenceOwner();
  const other = createItem("secret", "Other reference");
  other.value = "OTHER_REFERENCE_PRIVATE_SENTINEL";
  await vaultStore.addItems([other]);
  const held = holdReferenceResolution();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const view = render(<ReferenceKeys item={owner.item} />);
  try {
    await confirmReference();
    await held.started;
    view.rerender(<ReferenceKeys item={other} />);
    await act(async () => {
      await held.release();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: confirmationName })).toBeNull();
    expect(document.body.textContent).not.toContain(sentinel);
    expect(JSON.stringify(listNotices())).not.toContain(sentinel);
    await confirmReference();
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0]?.[1]).toContain(
      "OTHER_REFERENCE_PRIVATE_SENTINEL",
    );
    expect(saved.mock.calls[0]?.[1]).not.toContain(sentinel);
  } finally {
    await held.release();
  }
});

it("retires a completed plaintext intent when its toolbar unmounts", async () => {
  const owner = await referenceOwner();
  const held = holdReferenceResolution();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const view = render(<ReferenceKeys item={owner.item} />);
  try {
    await confirmReference();
    await held.started;
    view.unmount();
    await act(async () => {
      await held.release();
    });
    expect(saved).not.toHaveBeenCalled();
  } finally {
    await held.release();
  }
});

it("consumes the second press before the genuine resolver awaits", async () => {
  const owner = await referenceOwner();
  const held = holdReferenceResolution();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
  const user = userEvent.setup();
  render(<ReferenceKeys item={owner.item} />);
  try {
    await user.click(
      await screen.findByRole("button", { name: plaintextName }),
    );
    const confirm = screen.getByRole("button", { name: confirmationName });
    act(() => {
      confirm.click();
      confirm.click();
    });
    await held.started;
    expect(workflow.resolveLocalEnvTemplate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await held.release();
    });
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

it("preserves current-owner download failure notices without publishing private causes", async () => {
  const owner = await referenceOwner();
  const user = userEvent.setup();
  const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {
    throw new Error(sentinel);
  });
  render(<ReferenceKeys item={owner.item} />);
  await user.click(
    await screen.findByRole("button", { name: "Download reference template" }),
  );
  await waitFor(() =>
    expect(
      listNotices().some(
        (notice) => notice.body === "The template could not be written.",
      ),
    ).toBe(true),
  );
  expect(document.body.textContent).not.toContain(sentinel);
  expect(JSON.stringify(listNotices())).not.toContain(sentinel);
  await confirmReference();
  await waitFor(() =>
    expect(
      listNotices().some(
        (notice) =>
          notice.body === "The environment file could not be written.",
      ),
    ).toBe(true),
  );
  expect(saved).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain(sentinel);
  expect(JSON.stringify(listNotices())).not.toContain(sentinel);
  saved.mockImplementation(() => {});
  await confirmReference();
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(
      listNotices().some(
        (notice) =>
          notice.body === "The environment file could not be written.",
      ),
    ).toBe(false),
  );
  expect(saved.mock.calls[2]).toEqual([
    "plaintext.env",
    owner.expected,
    "text/plain",
  ]);
});
