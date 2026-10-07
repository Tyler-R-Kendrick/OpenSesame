/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import * as workflows from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import {
  enterPasswordRow,
  holdBrowserFailure,
  holdPasswordOperation,
  passwordRowOwner,
  renderPasswordRow,
} from "./SecretUpdate.authority.test-support.js";

afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const synthetic of [false, true]) {
  const transition = synthetic
    ? "synthetic entry and fresh owner recovery"
    : "ordinary lock and reauthentication";
  it(`discards a completed genuine compare verdict and retained candidate after ${transition}`, async () => {
    const f = await passwordRowOwner(synthetic);
    const held = holdPasswordOperation(f, false);
    renderPasswordRow(held.operation, async (value) => {
      await workflows.comparePrivatePassword(
        f.item.id,
        value,
        true,
        f.selected,
      );
    });
    const user = await enterPasswordRow("controlled-secondary-value");
    try {
      await user.click(
        screen.getByRole("button", { name: "Compare with the saved password" }),
      );
      await held.ready;
      await f.recover();
      await act(async () => {
        await held.drain();
      });
      expect(
        screen.queryByRole("img", { name: "Same as the saved password" }),
      ).toBeNull();
      expect(screen.queryByLabelText("New password")).toBeNull();
      expect(listNotices()).toEqual([]);
      const fresh = await enterPasswordRow("controlled-secondary-value");
      await fresh.click(
        screen.getByRole("button", { name: "Compare with the saved password" }),
      );
      expect(
        await screen.findByRole("img", { name: "Same as the saved password" }),
      ).toBeDefined();
    } finally {
      await held.drain();
    }
  });
  it(`does not send a held actual browser failure into a successor tray after ${transition}`, async () => {
    const f = await passwordRowOwner(synthetic);
    const held = holdBrowserFailure(f);
    renderPasswordRow(
      async (value) =>
        (
          await workflows.comparePrivatePassword(
            f.item.id,
            value,
            false,
            f.selected,
          )
        ).matches,
      held.operation,
    );
    const user = await enterPasswordRow("controlled-secondary-value");
    try {
      await user.click(screen.getByRole("button", { name: "Save new value" }));
      await held.ready;
      await f.recover();
      await act(async () => {
        await held.drain();
      });
      expect(listNotices()).toEqual([]);
      expect(screen.queryByLabelText("New password")).toBeNull();
    } finally {
      await held.drain();
    }
  });
  it(`does not close or populate the replacement editor for a completed genuine write after ${transition}`, async () => {
    const f = await passwordRowOwner(synthetic);
    const held = holdPasswordOperation(f, true);
    renderPasswordRow(
      async (value) =>
        (
          await workflows.comparePrivatePassword(
            f.item.id,
            value,
            false,
            f.selected,
          )
        ).matches,
      async (value) => {
        await held.operation(value);
      },
    );
    const user = await enterPasswordRow("legitimate-original-write");
    try {
      await user.click(screen.getByRole("button", { name: "Save new value" }));
      await held.ready;
      await f.recover();
      await enterPasswordRow("fresh-owner-intent");
      await act(async () => {
        await held.drain();
      });
      expect(screen.getByLabelText("New password")).toHaveProperty(
        "value",
        "fresh-owner-intent",
      );
      expect(listNotices()).toEqual([]);
      const persisted = vaultStore
        .getSnapshot()
        .items.find((entry) => entry.id === f.item.id);
      expect(persisted).toMatchObject({
        methods: [
          f.item.methods[0],
          expect.objectContaining({
            id: f.selected,
            secret: "legitimate-original-write",
          }),
        ],
        fields: f.item.fields,
      });
      await user.click(screen.getByRole("button", { name: "Save new value" }));
      // Await the second genuine completed write, rather than a timed UI sleep.
      await act(async () => {
        await held.drain();
      });
      expect(screen.queryByLabelText("New password")).toBeNull();
      expect(
        vaultStore.getSnapshot().items.find((entry) => entry.id === f.item.id),
      ).toMatchObject({ fields: f.item.fields });
      expect(
        (
          await workflows.comparePrivatePassword(
            f.item.id,
            "fresh-owner-intent",
            false,
            f.selected,
          )
        ).matches,
      ).toBe(true);
      expect(
        (
          await workflows.comparePrivatePassword(
            f.item.id,
            "protected-primary-value",
            false,
            f.item.methods[0].id,
          )
        ).matches,
      ).toBe(true);
    } finally {
      await held.drain();
    }
  });
}

it("never places an actual underlying browser failure cause into the notification tray", async () => {
  const f = await passwordRowOwner(false);
  const privateCause = "controlled-private-browser-error-cause";
  const read = f.root.getFileHandle.bind(f.root);
  vi.spyOn(f.root, "getFileHandle").mockImplementation(
    async (name, options) => {
      if (name === "controlled-failing-browser-file")
        throw new Error(privateCause);
      return read(name, options);
    },
  );
  let completed: Promise<void> | undefined;
  renderPasswordRow(
    async (value) =>
      (
        await workflows.comparePrivatePassword(
          f.item.id,
          value,
          false,
          f.selected,
        )
      ).matches,
    (value) => {
      completed = (async () => {
        await workflows.comparePrivatePassword(
          f.item.id,
          value,
          false,
          f.selected,
        );
        await f.root.getFileHandle("controlled-failing-browser-file");
      })();
      return completed;
    },
  );
  const user = await enterPasswordRow("controlled-secondary-value");
  await user.click(screen.getByRole("button", { name: "Save new value" }));
  await act(async () => {
    await completed?.catch(() => {});
  });
  expect(listNotices()).toEqual([
    expect.objectContaining({
      id: "vault:secret-update:controlled-owner-row:password",
      body: "Update failed.",
    }),
  ]);
  expect(JSON.stringify(listNotices())).not.toContain(privateCause);
  expect(document.body.textContent).not.toContain(privateCause);
  await f.recover();
  expect(listNotices()).toEqual([]);
});
