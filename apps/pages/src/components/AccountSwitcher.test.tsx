import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const orgs = vi.hoisted(() => ({
  lookupOrgTenant: vi.fn(),
  listOrgMemberships: vi.fn(),
  joinOrgTenant: vi.fn(),
}));

import { orgSeams } from "../lib/orgs.js";
Object.assign(orgSeams, {
  lookupOrgTenant: orgs.lookupOrgTenant,
  listOrgMemberships: orgs.listOrgMemberships,
  joinOrgTenant: orgs.joinOrgTenant,
});

import { identitySeams } from "../lib/identity.js";
Object.assign(identitySeams, {
  useIdentitySession: () => null,
  currentSession: () => null,
  connectProvisional: vi.fn(),
  identityBase: () => "http://127.0.0.1:18788",
});

import { federationSeams } from "../lib/federation.js";
const beginSignIn = vi.fn();
federationSeams.beginSignIn = beginSignIn;

import { GUEST_PROFILE_ID, setActiveOrgProfileId } from "../lib/orgs.js";
import { AccountSwitcher } from "./AccountSwitcher.js";

function renderSwitcher() {
  return render(
    <MemoryRouter>
      <AccountSwitcher />
    </MemoryRouter>,
  );
}

function openMenu() {
  const toggle = document.querySelector(".account-switcher__button");
  if (!toggle) throw new Error("account switcher toggle not rendered");
  fireEvent.click(toggle);
}

describe("AccountSwitcher", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setActiveOrgProfileId(GUEST_PROFILE_ID);
    orgs.lookupOrgTenant.mockReset();
    orgs.listOrgMemberships.mockReset();
    orgs.joinOrgTenant.mockReset();
    beginSignIn.mockReset();
    identitySeams.useIdentitySession = () => null;
    identitySeams.currentSession = () => null;
    orgs.listOrgMemberships.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it("shows Guest for an anonymous session and lets them add an organization", async () => {
    renderSwitcher();
    expect(screen.queryByText("Accounts")).toBeNull();
    openMenu();
    expect(screen.getByText("Accounts")).toBeTruthy();
    const guestItem = screen
      .getAllByRole("button", { name: "Guest" })
      .find((el) => el.className.includes("account-switcher__item"));
    expect(guestItem).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add organization" }));
    fireEvent.change(screen.getByLabelText("Organization slug"), {
      target: { value: "acme" },
    });
    orgs.lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [
        { kind: "sso", label: "SSO", issuer: "http://127.0.0.1:9090" },
        {
          kind: "saml",
          label: "SAML",
          issuer: "http://127.0.0.1:8080/realms/acme",
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with SSO" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with SAML" }),
    ).toBeTruthy();
  });

  it("starts SSO after minting a guest principal", async () => {
    identitySeams.connectProvisional = vi.fn(async () => ({
      principalId: "prn_guest",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    }));
    beginSignIn.mockResolvedValue(undefined);
    renderSwitcher();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add organization" }));
    fireEvent.change(screen.getByLabelText("Organization slug"), {
      target: { value: "acme" },
    });
    orgs.lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [
        { kind: "sso", label: "SSO", issuer: "http://127.0.0.1:9090" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByRole("button", { name: "Continue with SSO" });
    fireEvent.click(screen.getByRole("button", { name: "Continue with SSO" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(identitySeams.connectProvisional).toHaveBeenCalled();
    const [upstream, options] = beginSignIn.mock.calls[0] ?? [];
    expect(upstream).toMatchObject({
      issuer: "http://127.0.0.1:9090",
      accountKind: "SSO",
    });
    expect(options).toMatchObject({ orgSlug: "acme", orgMethod: "sso" });
  });

  it("brokers a native-SAML method instead of breaking on its missing issuer", async () => {
    identitySeams.connectProvisional = vi.fn(async () => ({
      principalId: "prn_guest",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    }));
    beginSignIn.mockResolvedValue(undefined);
    renderSwitcher();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add organization" }));
    fireEvent.change(screen.getByLabelText("Organization slug"), {
      target: { value: "acme" },
    });
    orgs.lookupOrgTenant.mockResolvedValue({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      // Native SAML runs server-side; there is no issuer for this tab.
      authMethods: [{ kind: "saml", label: "SAML", native: true }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with SAML" }),
    );
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    const [upstream, options] = beginSignIn.mock.calls[0] ?? [];
    expect(upstream).toMatchObject({
      id: "broker:org:acme",
      issuer: "http://127.0.0.1:18788",
    });
    // No org assertion comes back from a brokered leg, so no join is promised.
    expect(options).not.toHaveProperty("orgSlug");
  });

  it("lists org memberships for a connected guest", async () => {
    identitySeams.useIdentitySession = () => ({
      principalId: "prn_guest",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    orgs.listOrgMemberships.mockResolvedValue([
      {
        id: "org:acme",
        slug: "acme",
        displayName: "Acme",
        role: "member",
        state: "active",
      },
    ]);
    renderSwitcher();
    openMenu();
    expect(await screen.findByRole("button", { name: "Acme" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Acme" }));
    expect(screen.queryByText("Accounts")).toBeNull();
    expect(screen.getByRole("button", { name: /Acme/ })).toBeTruthy();
  });

  it("explains a tenant with no login methods", async () => {
    renderSwitcher();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add organization" }));
    fireEvent.change(screen.getByLabelText("Organization slug"), {
      target: { value: "empty" },
    });
    orgs.lookupOrgTenant.mockResolvedValue({
      slug: "empty",
      displayName: "Empty Co",
      state: "active",
      authMethods: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(
      await screen.findByText(/has not configured SSO or SAML/),
    ).toBeTruthy();
  });
});
