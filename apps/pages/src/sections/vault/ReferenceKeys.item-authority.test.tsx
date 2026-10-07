import { clearNotices } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { itemText } from "@opensesame/app-core/lib/vault/item-departure.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import {
  confirmReference,
  holdReferenceResolution,
  referenceOwner,
  sentinel,
} from "./ReferenceKeys.authority.fixture.js";
import { ReferenceKeys } from "./ReferenceKeys.js";

const replacementSentinel = "GENUINE_RESTORED_REFERENCE_PRIVATE_SENTINEL";
afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["replaceAll", "restoreWithdrawn"] as const)(
  "withholds completed plaintext when %s replaces its relevant record",
  async (method) => {
    const owner = await referenceOwner();
    const held = holdReferenceResolution();
    const saved = vi.spyOn(downloadSeams, "save").mockImplementation(() => {});
    const originalRecord = vaultStore
      .getSnapshot()
      .rawItems?.find((entry) => entry.id === owner.item.id);
    expect(originalRecord).toBeDefined();
    const replacement = { ...owner.item, value: replacementSentinel };
    render(<ReferenceKeys item={owner.item} />);
    try {
      await confirmReference();
      await held.started;
      await act(async () => {
        if (method === "replaceAll") {
          await vaultStore.replaceAll([replacement], []);
        } else {
          await vaultStore.withdrawItems({
            items: { [owner.item.id]: itemText(owner.item) },
            folderIds: [],
          });
          await vaultStore.restoreWithdrawn({
            items: [replacement],
            folders: [],
          });
        }
        const present = vaultStore
          .getSnapshot()
          .items.find((entry) => entry.id === owner.item.id);
        expect(present).toMatchObject({
          id: owner.item.id,
          value: replacementSentinel,
        });
        const currentRecord = vaultStore
          .getSnapshot()
          .rawItems?.find((entry) => entry.id === owner.item.id);
        expect(currentRecord).not.toBe(originalRecord);
        if (method === "replaceAll") {
          // Ordinary replacement actually restamps the changed record.
          expect(present?.updatedAt).not.toBe(owner.item.updatedAt);
        } else {
          // An absent restored ID retains the supplied version as documented.
          expect(present?.updatedAt).toBe(owner.item.updatedAt);
        }
        await held.release();
        expect(saved).not.toHaveBeenCalled();
      });
      const present = vaultStore
        .getSnapshot()
        .items.find((entry) => entry.id === owner.item.id);
      if (!present) throw new Error("Expected replacement item");
      cleanup();
      render(<ReferenceKeys item={present} />);
      await confirmReference();
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      expect(saved.mock.calls[0]?.[1]).toContain(replacementSentinel);
      expect(saved.mock.calls[0]?.[1]).not.toContain(sentinel);
    } finally {
      await held.release();
    }
  },
);
