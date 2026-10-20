/** @vitest-environment jsdom */
/**
 * The share sheet now opens on the session join generator: a name, the
 * scope, who may join and the optional identity audience. A live session
 * shows its link and QR only after that form is submitted.
 */
import { currentHost } from "@opensesame/app-core/lib/live/session.js";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveSharePanel } from "./LiveSharePanel.js";
import {
  github,
  installLiveFocusTests,
  press,
} from "./live-focus-test-support.js";
import { liveItemPickerCheckboxName } from "./live-item-picker-test.js";

describe("the share sheet", () => {
  installLiveFocusTests();

  it("opens on the generator and keeps Advanced folded", () => {
    const { container } = render(<LiveSharePanel />);
    const panel = within(container);
    expect(panel.getByLabelText("Session name")).toBeTruthy();
    expect(
      panel.getByRole("button", { name: /^Start the live session/ }),
    ).toBeTruthy();
    const advanced = container.querySelector<HTMLDetailsElement>(
      "details.live-advanced",
    );
    expect(advanced?.open).toBe(false);
  });

  it("starts a live session after the form is filled and shows its QR", async () => {
    const { container } = render(<LiveSharePanel />);
    const panel = within(container);
    fireEvent.change(panel.getByLabelText("Session name"), {
      target: { value: "Team" },
    });
    fireEvent.click(
      panel.getByRole("checkbox", {
        name: liveItemPickerCheckboxName(github),
      }),
    );
    const start = await panel.findByRole("button", {
      name: "Start the live session",
    });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    press(start);
    await panel.findByRole("img", { name: "Live" });
    expect(panel.getByRole("button", { name: "Copy the link" })).toBeTruthy();
    expect(
      panel.getByRole("img", { name: "Scan to join this live session" }),
    ).toBeTruthy();
    expect(currentHost()).not.toBeNull();
  });
});
