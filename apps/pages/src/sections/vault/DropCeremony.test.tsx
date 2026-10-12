import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { listNotices } from "@opensesame/app-core/lib/notices.js";

import { DropRecordFields, clockExpiry } from "./DropCeremony.js";
import {
  Ceremony,
  createClaim,
  expiryRow,
  installDropCeremonyHarness,
  makeDrop,
  makeSecret,
  pollClaim,
  store,
} from "./DropCeremony.test-support.js";

installDropCeremonyHarness();

describe("clock expiry", () => {
  const now = Date.parse("2026-08-30T09:00:00.000Z");

  it("adds what is left while the drop is ahead, and the time alone once it has lapsed", () => {
    expect(clockExpiry("2026-08-30T10:00:00.000Z", now)).toMatch(/left$/);
    const past = clockExpiry("2026-08-30T08:00:00.000Z", now);
    expect(past).not.toMatch(/left/);
    expect(past.length).toBeGreaterThan(0);
  });
});

describe("share ceremony on an item", () => {
  it("presses the one-hour choice at first and seals for the choice in force", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} />);
    const pressed = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("1 hour")).toBe("true");
    expect(pressed("10 minutes")).toBe("false");
    const hourExpiry = expiryRow();
    expect(hourExpiry).toMatch(/left$/);

    await user.click(screen.getByRole("button", { name: "1 day" }));
    expect(pressed("1 day")).toBe("true");
    expect(pressed("1 hour")).toBe("false");
    expect(expiryRow()).not.toBe(hourExpiry);
    expect(expiryRow()).toMatch(/left$/);

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");
    expect(createClaim.mock.calls[0]?.[1]).toBe(86_400_000);
    expect(
      screen.getByRole("region", { name: "Drop ready" }).textContent,
    ).toMatch(/Opens for\s*1 day/);
    expect(expiryRow()).not.toMatch(/left/);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("keeps a failed seal in the tray and leaves the form up", async () => {
    const user = userEvent.setup();
    createClaim.mockRejectedValue(new Error("The drop was not created."));
    render(<Ceremony item={makeSecret()} />);
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await waitFor(() =>
      expect(listNotices()[0]).toMatchObject({
        id: "vault:drop:itm_secret",
        title: "Drop",
        body: "The drop was not created.",
        tone: "err",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".note--err")).toBeNull();
    expect(screen.queryByText("Drop ready")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Opens for" })).toBeTruthy();
  });
});

describe("disposal", () => {
  it("shows state and countdown on the drop record", () => {
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Waiting to be opened")).toBeTruthy();
    expect(screen.getByText(/left$/)).toBeTruthy();
  });

  it("purges the record when the poll says the drop was opened", async () => {
    pollClaim.mockResolvedValue("consumed");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(store.purgeItem).toHaveBeenCalledWith("itm_drop"),
    );
  });

  it("keeps the record while the poll is pending", async () => {
    pollClaim.mockResolvedValue("pending");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await screen.findByText("Waiting to be opened");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.purgeItem).not.toHaveBeenCalled();
  });
});
