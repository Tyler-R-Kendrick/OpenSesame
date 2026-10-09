import { configureHost } from "@opensesame/app-core/host.js";
/** @vitest-environment jsdom */
/**
 * `/claim` is drop-receive only: a drop link opens the one-time code form;
 * ownership-claim paste and "Accept a claim" are not a product surface.
 */
import {
  captureClaimArrivalFromPage,
  peekClaimArrival,
  resetClaimArrivalForTests,
} from "@opensesame/app-core/lib/claims/arrival.js";
import { TOKEN } from "@opensesame/app-core/lib/claims/ceremony.fixture.js";
import { dropOpenSeams } from "@opensesame/app-core/lib/claims/drop-open.js";
import { CLAIM_NOTICE } from "@opensesame/app-core/lib/claims/route-model.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimRoute } from "./ClaimRoute.js";

const KEY = "a2V5LW1hdGVyaWFs"; // gitleaks:allow -- synthetic drop key test vector

function arrive(address: string) {
  history.replaceState(null, "", address);
  captureClaimArrivalFromPage();
}

function show() {
  return render(
    <MemoryRouter initialEntries={["/claim"]}>
      <ClaimRoute />
    </MemoryRouter>,
  );
}

function trayed() {
  return listNotices().find((notice) => notice.id.startsWith(CLAIM_NOTICE));
}

function claimCopyOnScreen(): string[] {
  const text = document.body.textContent ?? "";
  return [
    "Accept a claim",
    "Open a claim",
    "Paste a claim",
    "Claim link",
    "Accept claim",
    "Claim accepted",
    "Claim waiting",
  ].filter((phrase) => text.includes(phrase));
}

beforeEach(() => {
  configureHost(createTestHost());
  clearNotices();
  resetClaimArrivalForTests();
});

afterEach(() => {
  cleanup();
  resetClaimArrivalForTests();
  clearNotices();
});

describe("a drop link", () => {
  const presentClaim = dropOpenSeams.presentClaim;
  afterEach(() => {
    dropOpenSeams.presentClaim = presentClaim;
  });

  it("opens the receive view and never shows Accept a claim", async () => {
    const present = vi.fn(async () => {
      throw new Error("offline");
    });
    dropOpenSeams.presentClaim = present;
    arrive(`/claim#token=${TOKEN}&key=${KEY}`);
    expect(location.hash).toBe("");
    show();
    expect(screen.getByRole("heading", { name: "Open a drop" })).toBeTruthy();
    const code = await screen.findByLabelText("One-time code");
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(claimCopyOnScreen()).toEqual([]);
    expect(document.body.textContent).not.toMatch(/osc_clm_/);
    expect(present).not.toHaveBeenCalled();
    await userEvent.type(code, "ABCD{Enter}");
    await waitFor(() => expect(present).toHaveBeenCalledWith(TOKEN, "ABCD"));
    expect(peekClaimArrival().kind).toBe("drop");
    expect(claimCopyOnScreen()).toEqual([]);
  });
});

describe("non-drop arrivals", () => {
  it("refuses an ownership token without a key — open-drop shell only", async () => {
    arrive(`/claim#token=${TOKEN}`);
    show();
    expect(screen.getByRole("heading", { name: "Open a drop" })).toBeTruthy();
    expect(
      await screen.findByRole("img", {
        name: "This drop link is incomplete.",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(trayed()?.body).toBe("This drop link is incomplete."),
    );
    expect(screen.queryByLabelText("Consent code")).toBeNull();
    expect(screen.queryByLabelText("Claim link")).toBeNull();
    expect(screen.queryByPlaceholderText(/osc_clm_/)).toBeNull();
    expect(claimCopyOnScreen()).toEqual([]);
    expect(peekClaimArrival()).toEqual({ kind: "none" });
  });

  it("refuses a bearer the query string carried, without claim copy", async () => {
    arrive(`/claim?token=${TOKEN}`);
    expect(location.search).toBe("");
    show();
    await waitFor(() =>
      expect(trayed()?.body).toMatch(/drop link carried its token/),
    );
    expect(claimCopyOnScreen()).toEqual([]);
    expect(screen.queryByLabelText("Claim link")).toBeNull();
    expect(peekClaimArrival()).toEqual({ kind: "none" });
  });

  it("empty /claim is Open a drop with no paste field and no claim copy", () => {
    show();
    expect(screen.getByRole("heading", { name: "Open a drop" })).toBeTruthy();
    expect(screen.queryByLabelText("Claim link")).toBeNull();
    expect(screen.queryByPlaceholderText(/osc_clm_/)).toBeNull();
    expect(screen.queryByLabelText("One-time code")).toBeNull();
    expect(claimCopyOnScreen()).toEqual([]);
    expect(document.body.textContent).not.toContain("Accept a claim");
  });
});
