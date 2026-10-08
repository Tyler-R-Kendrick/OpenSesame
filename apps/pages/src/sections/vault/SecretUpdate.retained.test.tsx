/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import * as workflows from "@opensesame/app-core/lib/vault/password-workflows.js";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import {
  enterPasswordRow,
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
  it(`retires a displayed genuine verdict and typed candidate on ${synthetic ? "synthetic recovery" : "ordinary reauthentication"}`, async () => {
    const f = await passwordRowOwner(synthetic);
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
        await workflows.comparePrivatePassword(
          f.item.id,
          value,
          true,
          f.selected,
        );
      },
    );
    const user = await enterPasswordRow("controlled-secondary-value");
    await user.click(
      screen.getByRole("button", { name: "Compare with the saved password" }),
    );
    expect(
      await screen.findByRole("img", { name: "Same as the saved password" }),
    ).toBeDefined();
    await f.recover();
    expect(
      screen.queryByRole("img", { name: "Same as the saved password" }),
    ).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(listNotices()).toEqual([]);
    const fresh = await enterPasswordRow("a-fresh-different-value");
    await fresh.click(
      screen.getByRole("button", { name: "Compare with the saved password" }),
    );
    expect(
      await screen.findByRole("img", {
        name: "Differs from the saved password",
      }),
    ).toBeDefined();
  });
}
