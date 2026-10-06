/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateSecretPanel } from "./SecretUpdate.js";

afterEach(() => {
  cleanup();
  clearNotices();
});

const refusing = (message: string) => async () => {
  throw new Error(message);
};

describe("UpdateSecretPanel", () => {
  it("keeps two items' refusals apart: the notice is keyed by item", async () => {
    const view = render(
      <UpdateSecretPanel
        itemId="item-a"
        label="password"
        onUpdate={refusing("First was refused.")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    fireEvent.click(screen.getByRole("button", { name: "Save new value" }));
    await waitFor(() =>
      expect(listNotices().map((notice) => notice.id)).toEqual([
        "vault:secret-update:item-a:password",
      ]),
    );

    // Another item's panel takes the screen; the first notice outlives it.
    view.unmount();
    render(
      <UpdateSecretPanel
        itemId="item-b"
        label="password"
        onUpdate={refusing("Second was refused.")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    fireEvent.click(screen.getByRole("button", { name: "Save new value" }));
    await waitFor(() => expect(listNotices()).toHaveLength(2));
    expect(
      listNotices()
        .map((notice) => `${notice.id} ${notice.body}`)
        .sort(),
    ).toEqual([
      "vault:secret-update:item-a:password First was refused.",
      "vault:secret-update:item-b:password Second was refused.",
    ]);
  });
});
