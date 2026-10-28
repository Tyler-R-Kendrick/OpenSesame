import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  clearRotationQueue,
  loadRotationEvents,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import { rotationSeams } from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotationPanel } from "./RotationPanel.js";

installDoublePorts();

function snapshotApproving(approved: readonly string[]): CompositionSnapshot {
  const base = double.getSnapshot();
  if (base.plan === null) throw new Error("the double resolves a plan");
  return { ...base, plan: { ...base.plan, approvedCapabilities: approved } };
}

function renderPanel(item: ReturnType<typeof account>) {
  return render(
    <MemoryRouter>
      <RotationPanel item={item} scope="personal" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearRotationQueue();
  const hidden = snapshotApproving([]);
  Object.assign(capabilityPorts, {
    compositionStore: {
      ...double,
      getSnapshot: () => hidden,
    },
  });
  vi.stubGlobal("LanguageModel", { availability: async () => "unavailable" });
});
afterEach(() => {
  cleanup();
  rotationSeams.relay = null;
  clearRotationQueue();
  vi.unstubAllGlobals();
});

function account() {
  const item = createItem("account", "Private mail");
  item.uris = [{ id: "u1", uri: "https://mail.example.test", match: "domain" }];
  return item;
}

describe("RotationPanel", () => {
  it("enables a thirty-day automatic schedule for an account", () => {
    renderPanel(account());
    expect(screen.getByText(/On · every 30 days/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Automatic rotation" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("queues a manual rotation and says it is out of sync without a relay", async () => {
    renderPanel(account());
    await userEvent.click(
      screen.getByRole("button", { name: /Generate new password/i }),
    );
    expect(loadRotationEvents()).toHaveLength(1);
    expect(await screen.findByText(/Out of sync/u)).toBeTruthy();
  });

  it("warns on a generator-backed type with no provider path", () => {
    renderPanel(createItem("card", "Test card"));
    expect(screen.getByText(/couldn't verify this item type/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Automatic rotation" }),
    ).toBeNull();
  });

  it("warns when an account has no https site to target", () => {
    renderPanel(createItem("account", "Private mail"));
    expect(screen.getByText(/no https site to rotate/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Automatic rotation" }),
    ).toBeNull();
  });

  it("draws nothing for a type without a generator", () => {
    renderPanel(createItem("note", "Memo"));
    expect(screen.queryByRole("heading", { name: "Rotation" })).toBeNull();
  });
});
