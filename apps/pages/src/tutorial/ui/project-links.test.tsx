/** @vitest-environment jsdom */
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { mount, openPanel, resetSupport } from "./support-test-harness.js";

afterEach(resetSupport);

it("offers the ten project documents only from unlocked Support", async () => {
  const user = userEvent.setup();
  mount(fakeAgentAlwaysUnavailable("no_local_model"));
  const { panel } = await openPanel(user);
  const summary = within(panel).getByText("About this project");
  expect(summary.closest("details")?.open).toBe(false);
  await user.click(summary);
  const links = within(panel).getAllByRole("link");
  expect(links).toHaveLength(10);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("href")).toMatch(
      /^https:\/\/github\.com\/Tyler-R-Kendrick\/OpenSesame/,
    );
  }
  expect(
    within(panel)
      .getByRole("link", { name: "What it is" })
      .getAttribute("href"),
  ).toBe("https://github.com/Tyler-R-Kendrick/OpenSesame/blob/main/README.md");
  expect(
    within(panel).getByRole("link", { name: "Changelog" }).getAttribute("href"),
  ).toBe(
    "https://github.com/Tyler-R-Kendrick/OpenSesame/blob/main/docs/CHANGELOG.md",
  );
  expect(
    within(panel)
      .getByRole("link", { name: "Open a private advisory" })
      .getAttribute("href"),
  ).toBe(
    "https://github.com/Tyler-R-Kendrick/OpenSesame/security/advisories/new",
  );
});
