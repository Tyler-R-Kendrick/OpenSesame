import {
  clearRotationQueue,
  loadRotationEvents,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import { rotationSeams } from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RotationPanel } from "./RotationPanel.js";

beforeEach(() => clearRotationQueue());
afterEach(() => {
  cleanup();
  rotationSeams.relay = null;
  clearRotationQueue();
});

function account() {
  const item = createItem("account", "Private mail");
  item.uris = [{ id: "u1", uri: "https://mail.example.test", match: "domain" }];
  return item;
}

describe("RotationPanel", () => {
  it("enables a thirty-day automatic schedule for an account", () => {
    render(<RotationPanel item={account()} scope="personal" />);
    expect(screen.getByText(/On · every 30 days/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Automatic rotation" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("queues a manual rotation and says it is out of sync without a relay", async () => {
    render(<RotationPanel item={account()} scope="personal" />);
    await userEvent.click(
      screen.getByRole("button", { name: /Generate now/i }),
    );
    expect(loadRotationEvents()).toHaveLength(1);
    expect(await screen.findByText(/Out of sync/u)).toBeTruthy();
  });

  it("warns on a generator-backed type with no provider path", () => {
    render(
      <RotationPanel item={createItem("card", "Test card")} scope="personal" />,
    );
    expect(screen.getByText(/couldn't verify this item type/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Automatic rotation" }),
    ).toBeNull();
  });

  it("warns when an account has no https site to target", () => {
    render(
      <RotationPanel
        item={createItem("account", "Private mail")}
        scope="personal"
      />,
    );
    expect(screen.getByText(/no https site to rotate/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Automatic rotation" }),
    ).toBeNull();
  });

  it("draws nothing for a type without a generator", () => {
    render(
      <RotationPanel item={createItem("note", "Memo")} scope="personal" />,
    );
    expect(screen.queryByRole("heading", { name: "Rotation" })).toBeNull();
  });
});
