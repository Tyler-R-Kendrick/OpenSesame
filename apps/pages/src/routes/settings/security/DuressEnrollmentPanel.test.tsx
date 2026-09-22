/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_FIXTURE_CATALOG } from "../../../lib/duress/settings/index.js";
import { DuressEnrollmentPanel } from "./DuressEnrollmentPanel.js";

afterEach(() => cleanup());

function requireArmButton(): HTMLButtonElement {
  const armEl = document.getElementById("duress-arm");
  if (!(armEl instanceof HTMLButtonElement)) {
    throw new Error("expected arm control");
  }
  return armEl;
}

describe("DuressEnrollmentPanel", () => {
  it("renders preset exposure and keeps arm disabled until gates pass", async () => {
    const user = userEvent.setup();
    render(
      <DuressEnrollmentPanel
        catalog={SETTINGS_FIXTURE_CATALOG}
        authorizedOwner
        presentation="normal"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Duress profiles" }),
    ).toBeTruthy();
    expect(requireArmButton().disabled).toBe(true);

    await user.click(
      screen.getByRole("checkbox", {
        name: /I am the affected owner/i,
      }),
    );
    expect(requireArmButton().disabled).toBe(true);
  });

  it("shows ordinary labels for decoy foreground", () => {
    render(
      <DuressEnrollmentPanel
        catalog={SETTINGS_FIXTURE_CATALOG}
        authorizedOwner={false}
        presentation="decoy"
      />,
    );
    expect(screen.queryByText(/Recovery policy/i)).toBeNull();
    expect(screen.getByText(/Unlocked\.|Vault available/i)).toBeTruthy();
  });

  it("marks permission-prompt absence", () => {
    const { container } = render(
      <DuressEnrollmentPanel catalog={SETTINGS_FIXTURE_CATALOG} />,
    );
    const section = container.querySelector("#duress-profiles");
    expect(section?.getAttribute("data-permission-prompt")).toBe("false");
  });
});
