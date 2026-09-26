/** @vitest-environment jsdom */
/**
 * `/claim`: a claim link is reviewed and accepted over the one claim model; a
 * drop link is opened here too, on every installation (ADR 0140 D2); a
 * leaked bearer is refused; and with nothing arrived, a link can be pasted.
 * Every failure is a mark on the page (and a tray notice where the shell is
 * mounted), never a box.
 */
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
import { dropOpenSeams } from "@opensesame/app-core/lib/claims/drop-open.js";
import {
  CLAIM_ACCEPTED,
  CLAIM_NOTICE,
} from "@opensesame/app-core/lib/claims/route-model.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { ClaimRoute } from "./ClaimRoute.js";
import { claimHookSeams } from "./useClaimCeremony.js";

const KEY = "a2V5LW1hdGVyaWFs"; // gitleaks:allow -- synthetic drop key test vector
const session: { current: IdentitySession | null } = { current: null };
let harness = claimHarness();

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });
Object.assign(claimHookSeams, { ceremony: () => harness.ceremony });

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
  harness.routes.present.mockResolvedValue(json(OPEN_CLAIM));
  harness.routes.complete.mockResolvedValue(json({ ok: true }));
  clearNotices();
});

afterEach(() => {
  cleanup();
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
    // Focus lands in the effect that follows the step's commit, so wait for
    // it rather than read it on the render that drew the mark.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue as guest" })).toBe(
        document.activeElement,
      ),
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
  const presentClaim = dropOpenSeams.presentClaim;
  afterEach(() => {
    dropOpenSeams.presentClaim = presentClaim;
  });

  it("opens here, with no capability behind it, and is forgotten once settled", async () => {
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
    // Nothing is presented until the person enters the sender's code.
    expect(present).not.toHaveBeenCalled();
    expect(harness.routes.present).not.toHaveBeenCalled();
    await userEvent.type(code, "ABCD{Enter}");
    await waitFor(() => expect(present).toHaveBeenCalledWith(TOKEN, "ABCD"));
    // Unreachable is worth another try: the link stays, in memory only.
    expect(peekClaimArrival().kind).toBe("drop");
    expect(
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ).not.toContain(KEY);
  });
});
