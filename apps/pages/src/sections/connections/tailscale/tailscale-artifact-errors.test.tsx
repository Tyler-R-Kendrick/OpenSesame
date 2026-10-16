/** @vitest-environment jsdom */
import {
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeFixture,
  fixture,
  mount,
  resetFixture,
} from "./tailscale-ui.test-support.js";
beforeEach(resetFixture);
afterEach(() => {
  dismissNotice("tailscale-registration");
  vi.unstubAllGlobals();
  closeFixture();
});
it.each(["App name", "Tailnet"])(
  "reports invalid %s before download and performs no registration request",
  async (field) => {
    mount();
    fireEvent.change(await screen.findByLabelText(field), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Download registration request" }),
    );
    await waitFor(() =>
      expect(
        listNotices().find((notice) => notice.id === "tailscale-registration"),
      ).toMatchObject({
        title: "Tailscale",
        body: expect.stringContaining("Check the app name"),
      }),
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  },
);
it("refuses invalid attributes before copying any artifact and reports the failure through the same tray", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  mount();
  fireEvent.change(
    await screen.findByLabelText("Provisioned node attributes"),
    { target: { value: "tag:admin" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Copy registration request" }),
  );
  await waitFor(() =>
    expect(
      listNotices().some((notice) => notice.id === "tailscale-registration"),
    ).toBe(true),
  );
  expect(writeText).not.toHaveBeenCalled();
  expect(fixture.fetch).not.toHaveBeenCalled();
});
