/** @vitest-environment jsdom */
/**
 * The share sheet's one press (ADR 0150 as amended): Start sharing needs
 * no fields — it shares the vault the key sits beside, under the form's
 * own defaults — and everything else (chosen items, relay routes) stays
 * folded under Advanced until asked for.
 */
import { currentHost } from "@opensesame/app-core/lib/live/session.js";
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveSharePanel } from "./LiveSharePanel.js";
import { installLiveFocusTests, press } from "./live-focus-test-support.js";

describe("the share sheet", () => {
  installLiveFocusTests();

  it("keeps Advanced folded and asks for no field before the press", () => {
    const { container } = render(<LiveSharePanel />);
    const panel = within(container);
    expect(panel.getByRole("button", { name: "Start sharing" })).toBeTruthy();
    const advanced = container.querySelector<HTMLDetailsElement>(
      "details.live-advanced",
    );
    expect(advanced?.open).toBe(false);
  });

  it("starts a live session on the one press, with no form filled in", async () => {
    const { container } = render(<LiveSharePanel />);
    const panel = within(container);
    press(panel.getByRole("button", { name: "Start sharing" }));
    await panel.findByRole("img", { name: "Live" });
    expect(panel.getByRole("button", { name: "Copy the link" })).toBeTruthy();
    expect(currentHost()).not.toBeNull();
  });
});
