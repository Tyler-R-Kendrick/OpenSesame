/** @vitest-environment jsdom */
import { INITIAL_SNAPSHOT } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { profilePlan } from "../../lib/capabilities/__tests__/vault-profiles.js";
import { mount, openPanel, resetSupport } from "./support-test-harness.js";

afterEach(() => {
  resetSupport();
  clearNotices();
});

describe("support ask tab", () => {
  it("shows Search, not Ask, when nothing can answer", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);
    expect(screen.getByRole("tab", { name: "Search" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Ask" })).toBeNull();
  });

  it("keeps the Ask tab when local AI is approved and the model is not ready", async () => {
    const user = userEvent.setup();
    const plan = profilePlan("full");
    const snapshot = {
      ...INITIAL_SNAPSHOT,
      status: "ready" as const,
      plan,
    };
    const read = compositionStore.getSnapshot;
    compositionStore.getSnapshot = () => snapshot;
    try {
      mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
      await openPanel(user);
      expect(screen.getByRole("tab", { name: "Ask" })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: "Search" })).toBeNull();
      expect(
        await screen.findByLabelText("Search the written help"),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    } finally {
      compositionStore.getSnapshot = read;
    }
  });
});
