/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import * as workflows from "@opensesame/app-core/lib/vault/password-workflows.js";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import {
  enterPasswordRow,
  holdBrowserFailure,
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
for (const change of ["Cancel", "candidate", "mode"] as const) {
  it(`does not publish an actual held browser failure after ${change}, and releases busy for fresh genuine comparison`, async () => {
    const f = await passwordRowOwner(false);
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
      if (change === "Cancel") {
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText("New password")).toBeNull();
        await user.click(
          screen.getByRole("button", { name: "Update password" }),
        );
      } else if (change === "candidate") {
        await user.clear(screen.getByLabelText("New password"));
        await user.type(
          screen.getByLabelText("New password"),
          "fresh-different-candidate",
        );
      } else {
        await user.click(screen.getByRole("button", { name: "Generate" }));
        expect(screen.queryByLabelText("New password")).toBeNull();
      }
      await act(async () => {
        await held.drain();
      });
      expect(listNotices()).toEqual([]);
      expect(
        screen.getByRole("button", { name: "Save new value" }),
      ).toHaveProperty("disabled", false);
      if (change === "mode")
        await user.click(screen.getByRole("button", { name: "Enter" }));
      await user.click(
        screen.getByRole("button", { name: "Compare with the saved password" }),
      );
      const mark =
        change === "candidate"
          ? "Differs from the saved password"
          : "Same as the saved password";
      expect(await screen.findByRole("img", { name: mark })).toBeDefined();
      expect(listNotices()).toEqual([]);
    } finally {
      await held.drain();
    }
  });
}
