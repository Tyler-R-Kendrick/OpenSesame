import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fed = vi.hoisted(() => ({
  completeSignIn: vi.fn(),
  adoptBrokeredSession: vi.fn(),
  joinOrgTenant: vi.fn(),
  ensureIdentitySession: vi.fn(),
  adoptFederatedIdentity: vi.fn(),
}));

import { federationSeams } from "../lib/federation.js";
const originalFederationSeams = { ...federationSeams };
Object.assign(federationSeams, {
  completeSignIn: fed.completeSignIn,
  adoptBrokeredSession: fed.adoptBrokeredSession,
});

import { orgSeams } from "../lib/orgs.js";
Object.assign(orgSeams, { joinOrgTenant: fed.joinOrgTenant });

import { identitySeams } from "../lib/identity.js";
identitySeams.connectProvisional = fed.ensureIdentitySession;
identitySeams.currentSession = () => null;
identitySeams.identityBase = () => "http://127.0.0.1:18788";

import { guestAuthSeams } from "../lib/guest-auth.js";
guestAuthSeams.adoptFederatedIdentity = fed.adoptFederatedIdentity;

import { FederationError } from "../lib/federation.js";
import {
  FederationReturn,
  resetFederationReturnCeremony,
} from "./FederationReturn.js";

function renderReturn() {
  return render(
    <MemoryRouter initialEntries={["/?code=abc&state=xyz"]}>
      <Routes>
        <Route path="/" element={<FederationReturn />} />
        <Route path="/settings" element={<p>settings landed</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("FederationReturn", () => {
  beforeEach(() => {
    // The ceremony is single-flight per page load; a test that deliberately
    // leaves it unsettled must not poison the next one.
    resetFederationReturnCeremony();
    fed.completeSignIn.mockReset();
    fed.joinOrgTenant.mockReset();
    fed.ensureIdentitySession.mockReset();
    fed.adoptFederatedIdentity.mockReset();
    fed.adoptFederatedIdentity.mockResolvedValue({ kind: "linked" });
    fed.adoptBrokeredSession.mockReset();
    fed.adoptBrokeredSession.mockResolvedValue({
      principalId: "prn_broker",
      accessToken: "pst_first_party",
      issuerOrigin: "http://127.0.0.1:18788",
    });
  });

  afterEach(cleanup);

  it("shows progress while the sign-in completes", () => {
    fed.completeSignIn.mockReturnValue(new Promise(() => {}));
    renderReturn();
    expect(screen.getByText("Finishing sign-in…")).toBeTruthy();
  });

  it("returns to the page that started sign-in", async () => {
    fed.completeSignIn.mockResolvedValue({ returnTo: "/settings" });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
  });

  it("falls back to the app root when there is no returnTo", async () => {
    fed.completeSignIn.mockResolvedValue(null);
    renderReturn();
    // Navigated to "/", which still hosts this screen; no error shown.
    await waitFor(() => expect(fed.completeSignIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces federation errors with a way back", async () => {
    fed.completeSignIn.mockRejectedValue(
      new FederationError("access_denied", "Upstream refused the login."),
    );
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in didn't finish");
    // Mapped to plain words, with the no-change anchor — never the raw code.
    expect(alert.textContent).toContain("Access was denied at the provider.");
    expect(alert.textContent).toContain("Nothing was changed on this device.");
    // The way back does not re-attempt sign-in.
    fireEvent.click(screen.getByRole("button", { name: "Back to sign-in" }));
    expect(fed.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("surfaces plain errors verbatim", async () => {
    fed.completeSignIn.mockRejectedValue(new Error("network unreachable"));
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("network unreachable");
  });

  it("uses a generic message for non-Error failures", async () => {
    fed.completeSignIn.mockRejectedValue("weird");
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in failed.");
  });

  it("joins the org tenant after an SSO/SAML return", async () => {
    fed.ensureIdentitySession.mockResolvedValue({
      principalId: "prn_guest",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    fed.joinOrgTenant.mockResolvedValue({
      id: "org:acme",
      slug: "acme",
      displayName: "Acme",
      role: "member",
      state: "active",
    });
    fed.completeSignIn.mockResolvedValue({
      orgSlug: "acme",
      orgMethod: "sso",
      returnTo: "/settings",
      identity: { idToken: "id-token" },
    });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
    expect(fed.joinOrgTenant).toHaveBeenCalledWith("acme", "sso", "id-token");
    expect(fed.adoptFederatedIdentity).not.toHaveBeenCalled();
  });

  it("adopts the upstream identity with the id_token", async () => {
    fed.ensureIdentitySession.mockResolvedValue({
      principalId: "prn_guest",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    fed.completeSignIn.mockResolvedValue({
      returnTo: "/settings",
      identity: { idToken: "id-token" },
    });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
    expect(fed.ensureIdentitySession).not.toHaveBeenCalled();
    expect(fed.adoptFederatedIdentity).toHaveBeenCalledWith("id-token");
  });

  it("adopts a brokered sign-in through the session exchange, never the link path", async () => {
    fed.completeSignIn.mockResolvedValue({
      returnTo: "/settings",
      accessToken: "at_brokered",
      identity: { idToken: "pairwise-id-token" },
    });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
    expect(fed.adoptBrokeredSession).toHaveBeenCalledWith("at_brokered");
    // T23: the pairwise id_token beside it is never linked to this tab's
    // session, and the org join is not this branch either.
    expect(fed.adoptFederatedIdentity).not.toHaveBeenCalled();
    expect(fed.joinOrgTenant).not.toHaveBeenCalled();
  });

  it("prefers the org join when a brokered token rides along with an org return", async () => {
    fed.ensureIdentitySession.mockResolvedValue({
      principalId: "prn_guest",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    fed.joinOrgTenant.mockResolvedValue({ id: "org:acme" });
    fed.completeSignIn.mockResolvedValue({
      orgSlug: "acme",
      orgMethod: "sso",
      accessToken: "at_should_be_ignored",
      returnTo: "/settings",
      identity: { idToken: "id-token" },
    });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
    expect(fed.joinOrgTenant).toHaveBeenCalledWith("acme", "sso", "id-token");
    expect(fed.adoptBrokeredSession).not.toHaveBeenCalled();
  });

  it("shows the failure card when a brokered session cannot be adopted", async () => {
    fed.completeSignIn.mockResolvedValue({
      returnTo: "/settings",
      accessToken: "at_stale",
      identity: { idToken: "pairwise-id-token" },
    });
    fed.adoptBrokeredSession.mockRejectedValue(
      new Error("That sign-in expired before it could be adopted. Try again."),
    );
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("expired before it could be adopted");
    expect(screen.queryByText("settings landed")).toBeNull();
  });

  it("shows the failure card when the identity cannot be attached", async () => {
    fed.completeSignIn.mockResolvedValue({
      returnTo: "/settings",
      identity: { idToken: "id-token" },
    });
    fed.adoptFederatedIdentity.mockRejectedValue(
      new Error(
        "That account is already attached to a different OpenSesame identity.",
      ),
    );
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in didn't finish");
    expect(alert.textContent).toContain("already attached to a different");
    expect(screen.queryByText("settings landed")).toBeNull();
  });
});
