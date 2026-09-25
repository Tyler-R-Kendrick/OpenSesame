/** @vitest-environment jsdom */
/**
 * `/claim`: a claim link is reviewed and accepted over the one claim model; a
 * drop link is handed to whatever `sharing.drops` contributed, or refused in
 * the tray where drops are absent; a leaked bearer is refused; and with
 * nothing arrived, a link can be pasted. Every failure is a mark and a tray
 * notice, never a box on the page.
 */
import type { ClaimOpenerProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  captureClaimArrivalFromPage,
  peekClaimArrival,
  resetClaimArrivalForTests,
} from "@opensesame/app-core/lib/claims/arrival.js";
import {
  OPEN_CLAIM,
  TOKEN,
  claimHarness,
  json,
} from "@opensesame/app-core/lib/claims/ceremony.fixture.js";
import { CLAIM_WORDS } from "@opensesame/app-core/lib/claims/ceremony.js";
import {
  CLAIM_ACCEPTED,
  CLAIM_NOTICE,
  DROPS_UNAVAILABLE,
} from "@opensesame/app-core/lib/claims/route-model.js";
import {
  registerContributionForTest,
  resetContributionsForTest,
} from "@opensesame/app-core/lib/contributions.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { ClaimRoute, claimRouteSeams } from "./ClaimRoute.js";
import { claimHookSeams } from "./useClaimCeremony.js";

const KEY = "a2V5LW1hdGVyaWFs"; // gitleaks:allow -- synthetic drop key test vector
const session: { current: IdentitySession | null } = { current: null };
const drops: { approved: boolean | null } = { approved: true };
let harness = claimHarness();

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });
Object.assign(claimHookSeams, { ceremony: () => harness.ceremony });
Object.assign(claimRouteSeams, { useDropsApproved: () => drops.approved });

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
  return listNotices().find((notice) => notice.id === CLAIM_NOTICE);
}

beforeEach(() => {
  harness = claimHarness();
  session.current = overlapCast({ accessToken: "t", principalId: "prn_1" });
  drops.approved = true;
  harness.routes.present.mockResolvedValue(json(OPEN_CLAIM));
  harness.routes.complete.mockResolvedValue(json({ ok: true }));
  clearNotices();
});

afterEach(() => {
  cleanup();
  resetContributionsForTest();
  resetClaimArrivalForTests();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("a claim link", () => {
  it("left the address, is reviewed, and is accepted with the code", async () => {
    arrive(`/claim#token=${TOKEN}`);
    expect(location.hash).toBe("");
    show();

    const code = await screen.findByLabelText("Consent code");
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(harness.routes.present).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByText("agent")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("sha256:abc")).toBeTruthy();

    await userEvent.type(code, "WXYZ-1234{Enter}");
    expect(
      await screen.findByRole("img", { name: CLAIM_ACCEPTED }),
    ).toBeTruthy();
    const body = JSON.parse(harness.routes.complete.mock.calls[0]?.[1] ?? "");
    expect(body).toMatchObject({
      acceptedItemIds: ["item-1", "item-2"],
      userCode: "WXYZ-1234",
    });
    // Spent: nothing is held for the next person.
    expect(peekClaimArrival()).toEqual({ kind: "none" });
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Claim accepted" }),
    );
  });

  it("marks a wrong code and reports it in the tray, never in a box", async () => {
    harness.routes.complete.mockResolvedValue(
      json({ error: "invalid_user_code" }, 400),
    );
    arrive(`/claim#token=${TOKEN}`);
    const { container } = show();
    await userEvent.type(
      await screen.findByLabelText("Consent code"),
      "NOPE{Enter}",
    );
    await waitFor(() => expect(trayed()?.tone).toBe("err"));
    expect(
      screen.getByRole("img", { name: trayed()?.body ?? "" }),
    ).toBeTruthy();
    expect(container.querySelector(".note")).toBeNull();
    expect(screen.getByLabelText("Consent code")).toBeTruthy();
  });

  it("waits for a principal without presenting, then resumes when one arrives", async () => {
    session.current = null;
    harness.signIn(null);
    arrive(`/claim#token=${TOKEN}`);
    const view = show();
    expect(
      await screen.findByRole("img", { name: CLAIM_WORDS.signInFirst }),
    ).toBeTruthy();
    expect(harness.routes.present).not.toHaveBeenCalled();
    expect(trayed()).toBeUndefined();
    // The Connect note /device shows, and the guest road the model offers.
    expect(screen.getByRole("button", { name: "Continue as guest" })).toBe(
      document.activeElement,
    );

    harness.signIn("prn_1");
    session.current = overlapCast({ accessToken: "t", principalId: "prn_1" });
    view.rerender(
      <MemoryRouter initialEntries={["/claim"]}>
        <ClaimRoute />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Consent code");
    expect(harness.routes.present).toHaveBeenCalledTimes(1);
  });

  it("takes the guest road through a provisional principal", async () => {
    session.current = null;
    harness.signIn(null);
    arrive(`/claim#token=${TOKEN}`);
    show();
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue as guest" }),
    );
    await screen.findByLabelText("Consent code");
    expect(harness.routes.provisional).toHaveBeenCalledTimes(1);
  });

  it("refuses a bearer the query string carried, in the tray", async () => {
    arrive(`/claim?token=${TOKEN}`);
    expect(location.search).toBe("");
    show();
    await waitFor(() => expect(trayed()?.body).toBe(CLAIM_WORDS.leaked));
    expect(screen.getByRole("img", { name: CLAIM_WORDS.leaked })).toBeTruthy();
    expect(harness.routes.present).not.toHaveBeenCalled();
    expect(peekClaimArrival()).toEqual({ kind: "none" });
  });
});

describe("no link arrived", () => {
  it("offers a place to paste one, reads it once and clears it", async () => {
    show();
    const field = screen.getByLabelText<HTMLInputElement>("Claim link");
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.type(field, `https://pages.example/claim#token=${TOKEN}`);
    await userEvent.keyboard("{Enter}");
    await screen.findByLabelText("Consent code");
    expect(harness.routes.present).toHaveBeenCalledWith(TOKEN);
  });

  it("marks an entry that is not a claim", async () => {
    show();
    await userEvent.type(screen.getByLabelText("Claim link"), "hello{Enter}");
    expect(
      await screen.findByRole("img", { name: CLAIM_WORDS.notAToken }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Claim link").value).toBe(
      "",
    );
  });
});

describe("a drop link", () => {
  function Opener({ token, fragmentKey, onSettled }: ClaimOpenerProps) {
    return (
      <button type="button" onClick={onSettled}>
        {`${token}|${fragmentKey}`}
      </button>
    );
  }

  it("is handed to the opener sharing.drops contributed, and nothing is presented here", async () => {
    registerContributionForTest("claim-opener", {
      id: "drop",
      link: "drop",
      Opener,
      order: 50,
    });
    arrive(`/claim#token=${TOKEN}&key=${KEY}`);
    expect(location.hash).toBe("");
    show();
    expect(screen.getByRole("heading", { name: "Open a drop" })).toBeTruthy();
    const opener = screen.getByRole("button", { name: `${TOKEN}|${KEY}` });
    expect(harness.routes.present).not.toHaveBeenCalled();
    await userEvent.click(opener);
    expect(peekClaimArrival()).toEqual({ kind: "none" });
  });

  it("waits for the opener while an approved module is still loading", () => {
    arrive(`/claim#token=${TOKEN}&key=${KEY}`);
    show();
    expect(screen.queryByRole("button")).toBeNull();
    expect(trayed()).toBeUndefined();
    act(() => {
      registerContributionForTest("claim-opener", {
        id: "drop",
        link: "drop",
        Opener,
        order: 50,
      });
    });
    expect(
      screen.getByRole("button", { name: `${TOKEN}|${KEY}` }),
    ).toBeTruthy();
  });

  it("is refused in the tray where drops are not approved, and nothing is loaded", async () => {
    drops.approved = false;
    arrive(`/claim#token=${TOKEN}&key=${KEY}`);
    show();
    await waitFor(() => expect(trayed()?.body).toBe(DROPS_UNAVAILABLE));
    expect(screen.getByRole("img", { name: DROPS_UNAVAILABLE })).toBeTruthy();
    expect(harness.routes.present).not.toHaveBeenCalled();
    // Held in memory for this sitting only; nothing was stored.
    expect(peekClaimArrival().kind).toBe("drop");
    expect(
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ).not.toContain(KEY);
  });

  it("says nothing while no plan is resolved", () => {
    drops.approved = null;
    arrive(`/claim#token=${TOKEN}&key=${KEY}`);
    show();
    expect(trayed()).toBeUndefined();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
