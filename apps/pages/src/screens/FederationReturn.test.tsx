import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
/** @vitest-environment jsdom */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fed = vi.hoisted(() => ({
  completeSignIn: vi.fn(),
  adoptBrokeredSession: vi.fn(),
  joinOrgTenant: vi.fn(),
  ensureIdentitySession: vi.fn(),
  adoptFederatedIdentity: vi.fn(),
  openVaultAfterSignIn: vi.fn(),
}));

import { federationSeams } from "@opensesame/app-core/lib/federation.js";
const originalFederationSeams = { ...federationSeams };
Object.assign(federationSeams, {
  completeSignIn: fed.completeSignIn,
  adoptBrokeredSession: fed.adoptBrokeredSession,
});
afterAll(() => Object.assign(federationSeams, originalFederationSeams));

import { orgSeams } from "@opensesame/app-core/lib/orgs.js";
Object.assign(orgSeams, { joinOrgTenant: fed.joinOrgTenant });

import { identitySeams } from "@opensesame/app-core/lib/identity.js";
identitySeams.connectProvisional = fed.ensureIdentitySession;
identitySeams.currentSession = () => null;
identitySeams.identityBase = () => "http://127.0.0.1:18788";

import { guestAuthSeams } from "@opensesame/app-core/lib/guest-auth.js";
guestAuthSeams.adoptFederatedIdentity = fed.adoptFederatedIdentity;
guestAuthSeams.openVaultAfterSignIn = fed.openVaultAfterSignIn;

import { readAuthOutcome } from "@opensesame/app-core/lib/auth-outcome.js";

import { FederationError } from "@opensesame/app-core/lib/federation.js";
import { resetFederationReturnCeremony } from "@opensesame/app-core/screens/federation-return-model.js";
import { FederationReturn } from "./FederationReturn.js";

/** Where the router is now, so a test can wait for a navigation to land. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{`${pathname}${search}`}</output>;
}

function renderReturn() {
  return render(
    <MemoryRouter initialEntries={["/?code=abc&state=xyz"]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<FederationReturn />} />
        <Route path="/settings" element={<p>settings landed</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The tray holds a status notice carrying every part; the page does not. */
async function trayHas(...parts: string[]) {
  await waitFor(() =>
    expect(
      listNotices().some(
        (n) =>
          n.kind === "status" &&
          parts.every((part) => `${n.title} ${n.body}`.includes(part)),
      ),
    ).toBe(true),
  );
  expect(document.body.textContent).not.toContain(parts[parts.length - 1]);
}

const noFailures = () => listNotices().filter((n) => n.kind === "status");

describe("FederationReturn", () => {
  beforeEach(() => {
    sessionStorage.clear();
    // The ceremony is single-flight per page load; a test that deliberately
    // leaves it unsettled must not poison the next one.
    resetFederationReturnCeremony();
    fed.completeSignIn.mockReset();
    fed.joinOrgTenant.mockReset();
    fed.ensureIdentitySession.mockReset();
    fed.adoptFederatedIdentity.mockReset();
    fed.adoptFederatedIdentity.mockResolvedValue({ kind: "linked" });
    fed.openVaultAfterSignIn.mockReset();
    // Default posture: the vault stayed locked, so outcomes are bannered.
    fed.openVaultAfterSignIn.mockResolvedValue(false);
    fed.adoptBrokeredSession.mockReset();
    fed.adoptBrokeredSession.mockResolvedValue({
      principalId: "prn_broker",
      accessToken: "pst_first_party",
      issuerOrigin: "http://127.0.0.1:18788",
    });
  });

  afterEach(() => {
    cleanup();
    clearNotices();
  });

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
    // Navigated to "/", which still hosts this screen; no error shown. Wait
    // for the navigation itself: an absence checked before it proves nothing.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/"),
    );
    expect(fed.completeSignIn).toHaveBeenCalledTimes(1);
    expect(noFailures()).toEqual([]);
  });

  it("surfaces federation errors with a way back", async () => {
    fed.completeSignIn.mockRejectedValue(
      new FederationError("access_denied", "Upstream refused the login."),
    );
    renderReturn();
    // Mapped to plain words, with the no-change anchor — never the raw code.
    await trayHas(
      "Sign-in didn't finish",
      "Access was denied at the provider.",
      "Nothing was changed on this device.",
    );
    // The way back does not re-attempt sign-in.
    fireEvent.click(screen.getByRole("button", { name: "Back to sign-in" }));
    expect(fed.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("surfaces plain errors verbatim", async () => {
    fed.completeSignIn.mockRejectedValue(new Error("network unreachable"));
    renderReturn();
    await trayHas("network unreachable");
  });

  it("uses a generic message for non-Error failures", async () => {
    fed.completeSignIn.mockRejectedValue("weird");
    renderReturn();
    await trayHas("Sign-in failed.");
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

  it("ambient intent never links, joins, or opens a vault", async () => {
    fed.completeSignIn.mockResolvedValue({
      intent: {
        kind: "ambient",
        policyRevision: "rev1",
        selectedProviderKey: "oidc|https://idp.example|spa|",
      },
      identity: {
        issuer: "https://idp.example",
        upstreamId: "oidc",
        idToken: "id-token",
        pairwiseSub: "sub-1",
        audience: "spa",
        jwksUri: "https://idp.example/jwks",
        expiresAt: Date.now() + 60_000,
        name: "Pat",
      },
      claims: {
        iss: "https://idp.example",
        sub: "sub-1",
        aud: "spa",
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
      },
      transactionId: "tx1",
      generation: 0,
      policyRevision: "rev1",
    });
    renderReturn();
    await waitFor(() => expect(fed.completeSignIn).toHaveBeenCalledTimes(1));
    expect(fed.adoptFederatedIdentity).not.toHaveBeenCalled();
    expect(fed.openVaultAfterSignIn).not.toHaveBeenCalled();
    expect(fed.joinOrgTenant).not.toHaveBeenCalled();
    expect(fed.adoptBrokeredSession).not.toHaveBeenCalled();
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
    await trayHas("expired before it could be adopted");
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
    await trayHas("Sign-in didn't finish", "already attached to a different");
    expect(screen.queryByText("settings landed")).toBeNull();
  });

  it("opens the vault after a brokered sign-in so a first run lands in the app", async () => {
    // No returnTo: this is a plain sign-in, not a broker-consent resume.
    fed.completeSignIn.mockResolvedValue({
      accessToken: "at_brokered",
      identity: { idToken: "pairwise-id-token" },
    });
    fed.openVaultAfterSignIn.mockResolvedValue(true);
    renderReturn();
    await waitFor(() =>
      expect(fed.openVaultAfterSignIn).toHaveBeenCalledTimes(1),
    );
    // Landing in the app means no banner is stored — a stored one would only
    // resurface stale on the next lock.
    expect(readAuthOutcome()).toBeNull();
    expect(noFailures()).toEqual([]);
  });

  it("banners a brokered sign-in that comes back to a locked vault", async () => {
    fed.completeSignIn.mockResolvedValue({
      accessToken: "at_brokered",
      identity: { idToken: "pairwise-id-token" },
    });
    fed.openVaultAfterSignIn.mockResolvedValue(false);
    renderReturn();
    await waitFor(() => expect(readAuthOutcome()?.kind).toBe("linked"));
    expect(fed.openVaultAfterSignIn).toHaveBeenCalledTimes(1);
  });

  it("never invents a vault when the sign-in is resuming somewhere specific", async () => {
    fed.completeSignIn.mockResolvedValue({
      returnTo: "/settings",
      accessToken: "at_brokered",
      identity: { idToken: "pairwise-id-token" },
    });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
    expect(fed.openVaultAfterSignIn).not.toHaveBeenCalled();
    expect(readAuthOutcome()?.kind).toBe("linked");
  });

  it("skips the banner when a direct sign-in lands inside the app", async () => {
    fed.completeSignIn.mockResolvedValue({
      identity: { idToken: "id-token" },
    });
    fed.openVaultAfterSignIn.mockResolvedValue(true);
    renderReturn();
    await waitFor(() =>
      expect(fed.adoptFederatedIdentity).toHaveBeenCalledWith("id-token"),
    );
    // The return has finished when it navigates; a banner's absence checked
    // before that is only a banner not yet written.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/"),
    );
    expect(readAuthOutcome()).toBeNull();
  });

  it("stores no banner when the locked vault defers the link — the bell owns that", async () => {
    fed.completeSignIn.mockResolvedValue({
      identity: { idToken: "id-token" },
    });
    fed.adoptFederatedIdentity.mockResolvedValue({ kind: "pending_link" });
    renderReturn();
    await waitFor(() =>
      expect(fed.adoptFederatedIdentity).toHaveBeenCalledWith("id-token"),
    );
    // The return has finished when it navigates; a banner's absence checked
    // before that is only a banner not yet written.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/"),
    );
    expect(readAuthOutcome()).toBeNull();
  });
});
