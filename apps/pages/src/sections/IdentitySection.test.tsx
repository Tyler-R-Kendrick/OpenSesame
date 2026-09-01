import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentitySession } from "../lib/identity.js";
import type { IdpRecord } from "../lib/idp-registry.js";

const online = vi.hoisted(() => ({ value: true }));
const session: { current: IdentitySession | null } = vi.hoisted(() => ({
  current: null,
}));
const connect = vi.hoisted(() => vi.fn());
const beginSignIn = vi.hoisted(() => vi.fn());
const listFederatedProviders = vi.hoisted(() => vi.fn());
const registerByoProvider = vi.hoisted(() => vi.fn());
const registry: { raw: string | null } = vi.hoisted(() => ({ raw: null }));

import { identitySeams } from "../lib/identity.js";
Object.assign(identitySeams, {
  identityBase: () => "http://127.0.0.1:8788",
  useConnect: () => ({ connect, connecting: false, error: null }),
  useIdentitySession: () => session.current,
});

import { useOnlineSeams } from "../lib/use-online.js";
Object.assign(useOnlineSeams, { useOnline: () => online.value });

import { idpRegistrySeams } from "../lib/idp-registry.js";
Object.assign(idpRegistrySeams, {
  read: () => registry.raw,
  write: (raw: string) => {
    registry.raw = raw;
  },
  clear: () => {
    registry.raw = null;
  },
});

import { providersSeams } from "../lib/providers.js";
Object.assign(providersSeams, { listFederatedProviders });

import { federationSeams } from "../lib/federation.js";
Object.assign(federationSeams, {
  beginSignIn,
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google (via shoo.dev)",
  }),
});

import { ByoError, byoSeams } from "../lib/byo.js";
Object.assign(byoSeams, { registerByoProvider });

const directory = vi.hoisted(() => ({
  getMe: vi.fn(),
  listLinkedIdentities: vi.fn(),
  unlinkIdentity: vi.fn(),
  listOAuthClients: vi.fn(),
  createOAuthClient: vi.fn(),
  rotateOAuthClient: vi.fn(),
  revokeOAuthClient: vi.fn(),
  listOrgMembers: vi.fn(),
  addOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  createOrganization: vi.fn(),
  approveDevice: vi.fn(),
}));

import { DirectoryError, directorySeams } from "../lib/directory.js";
Object.assign(directorySeams, directory);

const access = vi.hoisted(() => ({
  listDelegations: vi.fn(),
  revokeDelegation: vi.fn(),
  claimDelegation: vi.fn(),
}));

import { accessSeams } from "../lib/access.js";
Object.assign(accessSeams, access);

const presentOffer = vi.hoisted(() => vi.fn());

import { claimSeams } from "../lib/claim.js";
Object.assign(claimSeams, { presentOffer });

const listOrgMemberships = vi.hoisted(() => vi.fn());
const activeOrgProfileId = vi.hoisted(() => vi.fn());

import { orgSeams } from "../lib/orgs.js";
Object.assign(orgSeams, { listOrgMemberships, activeOrgProfileId });

import type { Delegation } from "../lib/access.js";
import { listIdpRegistrations, registerIdp } from "../lib/idp-registry.js";
import { IdentitySection } from "./IdentitySection.js";

function makeRecord(overrides: Partial<IdpRecord> = {}): IdpRecord {
  return {
    id: "google",
    issuer: "http://127.0.0.1:8788",
    label: "Google",
    kind: "first-class",
    registeredAt: "2026-08-29T10:00:00Z",
    ...overrides,
  };
}

function makeDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: "dlg_1",
    offerId: "off_1",
    connectionId: "conn_github",
    claimantSubject: "prn_op",
    grantId: "gr_1",
    executionMode: "broker",
    actions: ["read"],
    resources: ["repo:opensesame"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

/** The hard rule from the design contract: no multi-sentence paragraphs. */
function expectProseBudget(container: HTMLElement) {
  for (const p of container.querySelectorAll("p")) {
    const text = p.textContent ?? "";
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence.trim().length > 0);
    expect(
      sentences.length,
      `multi-sentence paragraph: ${text}`,
    ).toBeLessThanOrEqual(1);
  }
}

type ClientOverrides = { id?: string; state?: string };

function makeClient(overrides: ClientOverrides = {}) {
  return {
    id: "cli_1",
    displayName: "Release pipeline",
    admissionMode: "pre_registered",
    state: "active",
    redirectUris: ["https://ci.example.com/callback"],
    sectorIdentifier: "https://ci.example.com",
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function renderIdentity() {
  return render(
    <MemoryRouter>
      <IdentitySection />
    </MemoryRouter>,
  );
}

async function openTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name }));
}

function firstButton(name: string): HTMLElement {
  const matches = screen.getAllByRole("button", { name });
  const found = matches[0];
  if (!found) throw new Error(`no button named ${name}`);
  return found;
}

describe("IdentitySection", () => {
  beforeEach(() => {
    online.value = true;
    registry.raw = null;
    session.current = {
      principalId: "prn_op",
      accessToken: "tok_1",
      issuerOrigin: "http://127.0.0.1:8788",
    };

    listFederatedProviders.mockResolvedValue([
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
    ]);
    beginSignIn.mockResolvedValue(undefined);
    registerByoProvider.mockResolvedValue({
      id: "byo_1",
      issuer: "https://auth.example.dev",
      label: "Example IdP",
      clientId: "cli_x",
      clientAuth: "client_secret_basic",
      registrationSource: "manual",
      redirectUri: "http://127.0.0.1:8788/v1/federated/callback",
    });

    directory.getMe.mockResolvedValue({
      id: "prn_op",
      state: "active",
      assurance: "verified",
      createdAt: "2026-08-01T00:00:00Z",
      version: 3,
    });
    directory.listLinkedIdentities.mockResolvedValue([]);
    directory.unlinkIdentity.mockResolvedValue(undefined);
    directory.listOAuthClients.mockResolvedValue([]);
    directory.createOAuthClient.mockResolvedValue(makeClient({ id: "cli_2" }));
    directory.rotateOAuthClient.mockResolvedValue(makeClient({ id: "cli_3" }));
    directory.revokeOAuthClient.mockResolvedValue(
      makeClient({ state: "revoked" }),
    );
    directory.listOrgMembers.mockResolvedValue([]);
    directory.addOrgMember.mockResolvedValue({
      organizationId: "org:1",
      principalId: "prn_new",
      role: "member",
      createdAt: "2026-08-29T00:00:00Z",
    });
    directory.removeOrgMember.mockResolvedValue(undefined);
    directory.createOrganization.mockResolvedValue({
      id: "org:2",
      slug: "acme-corp",
      displayName: "Acme Corp",
      state: "active",
      role: "owner",
      createdAt: "2026-08-29T00:00:00Z",
    });
    directory.approveDevice.mockResolvedValue({ ok: true, status: 200 });

    access.listDelegations.mockResolvedValue([]);
    access.revokeDelegation.mockResolvedValue(undefined);
    access.claimDelegation.mockResolvedValue([]);
    presentOffer.mockRejectedValue(
      new Error("presentOffer was not expected in this test"),
    );

    listOrgMemberships.mockResolvedValue([]);
    activeOrgProfileId.mockReturnValue("guest");
    connect.mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("gates on the ceremony while the registry is empty", async () => {
    renderIdentity();
    expect(
      await screen.findByText("Connect your identity provider"),
    ).toBeTruthy();
    // The presets lead the ceremony — one monogram tile each.
    for (const label of ["WorkOS", "Okta", "Auth0", "Better Auth"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // Then the custom-OIDC card, then the branded first-class row as the
    // secondary "Sign-in providers" section.
    expect(screen.getByLabelText(/Custom OIDC issuer/i)).toBeTruthy();
    expect(screen.getByText("Sign-in providers")).toBeTruthy();
    // `find`, not `get`: the heading above renders immediately but the row
    // beneath it waits on the provider catalog, which is a *second* async
    // resolution this test never awaited. Locally both settle in the same
    // flush and it passes; under CI load it does not.
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(screen.getByText("Set up later")).toBeTruthy();
    // No tabs behind the gate.
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("records a first-class provider and starts the brokered leg in one gesture", async () => {
    renderIdentity();
    await screen.findByText("Connect your identity provider");
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue with Google" }),
    );

    await waitFor(() => expect(beginSignIn).toHaveBeenCalled());
    expect(beginSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "broker:google" }),
      { providerHint: "google" },
    );
    expect(listIdpRegistrations()).toEqual([
      expect.objectContaining({ id: "google", kind: "first-class" }),
    ]);
    // The gate lifts onto the Providers tab with the success line.
    expect(
      await screen.findByText(/Google now vouches for sign-ins on this device/),
    ).toBeTruthy();
  });

  it("runs the custom OIDC card two-step on registration_unsupported", async () => {
    registerByoProvider.mockRejectedValueOnce(
      new ByoError(
        "registration_unsupported",
        "This provider cannot register clients automatically — create one there and enter its details.",
      ),
    );
    renderIdentity();
    await screen.findByText("Connect your identity provider");

    await userEvent.type(
      screen.getByLabelText(/Custom OIDC issuer/i),
      "https://auth.example.dev",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Check issuer/i }),
    );

    // Step 2: client credentials plus the deployment's redirect URI to copy.
    expect(await screen.findByLabelText(/^Client ID$/i)).toBeTruthy();
    expect(
      screen.getByText(/cannot register clients automatically/),
    ).toBeTruthy();
    expect(
      screen.getByText("http://127.0.0.1:8788/v1/federated/callback"),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Copy redirect URI/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/v1/federated/callback",
    );

    await userEvent.type(screen.getByLabelText(/^Client ID$/i), "cli_x");
    await userEvent.type(screen.getByLabelText(/Client secret/i), "sec_1");
    await userEvent.click(
      screen.getByRole("button", { name: /Register with this client/i }),
    );

    await waitFor(() =>
      expect(registerByoProvider).toHaveBeenLastCalledWith({
        issuer: "https://auth.example.dev",
        clientId: "cli_x",
        clientSecret: "sec_1",
      }),
    );
    expect(
      await screen.findByText(
        /Example IdP now vouches for sign-ins on this device/,
      ),
    ).toBeTruthy();
    expect(listIdpRegistrations()).toEqual([
      expect.objectContaining({
        id: "byo_1",
        kind: "byo",
        clientId: "cli_x",
        redirectUri: "http://127.0.0.1:8788/v1/federated/callback",
      }),
    ]);
  });

  it("registers an Okta preset through the BYO path with providerType set", async () => {
    renderIdentity();
    await screen.findByText("Connect your identity provider");

    await userEvent.click(screen.getByRole("button", { name: "Okta" }));
    // The preset form replaces the tiles; its domain field leads the focus.
    const domain = await screen.findByLabelText(/Okta domain/i);
    expect(document.activeElement).toBe(domain);
    expect(screen.queryByRole("button", { name: "Auth0" })).toBeNull();

    await userEvent.type(domain, "https://dev-123456.okta.com/");
    // The preset form's submit leads the custom card's in document order.
    await userEvent.click(firstButton("Check issuer"));

    await waitFor(() =>
      expect(registerByoProvider).toHaveBeenCalledWith({
        issuer: "https://dev-123456.okta.com",
      }),
    );
    expect(
      await screen.findByText(/Okta now vouches for sign-ins on this device/),
    ).toBeTruthy();
    expect(listIdpRegistrations()).toEqual([
      expect.objectContaining({
        id: "byo_1",
        kind: "byo",
        providerType: "okta",
        label: "Okta",
      }),
    ]);
  });

  it("runs the WorkOS preset two-step on registration_unsupported", async () => {
    registerByoProvider.mockRejectedValueOnce(
      new ByoError(
        "registration_unsupported",
        "This provider cannot register clients automatically — create one there and enter its details.",
      ),
    );
    renderIdentity();
    await screen.findByText("Connect your identity provider");

    await userEvent.click(screen.getByRole("button", { name: "WorkOS" }));
    // WorkOS has no domain field — the fixed AuthKit issuer is named instead.
    expect(screen.getByText("https://api.workos.com")).toBeTruthy();
    expect(screen.queryByLabelText(/Okta domain/i)).toBeNull();
    await userEvent.click(firstButton("Check issuer"));

    // Step 2 reveals the client fields exactly like the custom card.
    expect(await screen.findByLabelText(/^Client ID$/i)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/^Client ID$/i), "cli_w");
    await userEvent.type(screen.getByLabelText(/Client secret/i), "sec_w");
    await userEvent.click(
      screen.getByRole("button", { name: /Register with this client/i }),
    );

    await waitFor(() =>
      expect(registerByoProvider).toHaveBeenLastCalledWith({
        issuer: "https://api.workos.com",
        clientId: "cli_w",
        clientSecret: "sec_w",
      }),
    );
    expect(
      await screen.findByText(/WorkOS now vouches for sign-ins on this device/),
    ).toBeTruthy();
    expect(listIdpRegistrations()).toEqual([
      expect.objectContaining({ kind: "byo", providerType: "workos" }),
    ]);
  });

  it("validates the Better Auth URL client-side before registering", async () => {
    renderIdentity();
    await screen.findByText("Connect your identity provider");

    await userEvent.click(screen.getByRole("button", { name: "Better Auth" }));
    const url = await screen.findByLabelText(/Deployment URL/i);

    // http off-loopback never leaves the browser.
    await userEvent.type(url, "http://auth.acme.com");
    await userEvent.click(firstButton("Check issuer"));
    expect(
      await screen.findByText(/https is required, except on localhost/),
    ).toBeTruthy();
    expect(registerByoProvider).not.toHaveBeenCalled();

    // Loopback http is the local-dev carve-out; trailing slashes normalize off.
    await userEvent.clear(url);
    await userEvent.type(url, "http://localhost:3000/");
    await userEvent.click(firstButton("Check issuer"));
    await waitFor(() =>
      expect(registerByoProvider).toHaveBeenCalledWith({
        issuer: "http://localhost:3000",
      }),
    );
    expect(
      await screen.findByText(
        /Better Auth now vouches for sign-ins on this device/,
      ),
    ).toBeTruthy();
    expect(listIdpRegistrations()).toEqual([
      expect.objectContaining({ kind: "byo", providerType: "better-auth" }),
    ]);
  });

  it("returns from a preset form to the preset tiles on Back", async () => {
    renderIdentity();
    await screen.findByText("Connect your identity provider");

    await userEvent.click(screen.getByRole("button", { name: "Auth0" }));
    expect(await screen.findByLabelText(/Tenant domain/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Back$/i }));

    expect(screen.queryByLabelText(/Tenant domain/i)).toBeNull();
    for (const label of ["WorkOS", "Okta", "Auth0", "Better Auth"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(registerByoProvider).not.toHaveBeenCalled();
  });

  it("renders one tab at a time with aria-selected once the gate is lifted", async () => {
    registerIdp(makeRecord());
    renderIdentity();

    for (const name of [
      "People",
      "Providers",
      "Devices",
      "Service accounts",
      "Organization",
    ]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(
      screen.getByRole("tab", { name: "People" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "Providers" })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(await screen.findByText("You")).toBeTruthy();
    expect(screen.queryByText("Who vouches for them")).toBeNull();

    await openTab("Providers");
    expect(await screen.findByText("Who vouches for them")).toBeTruthy();
    expect(screen.queryByText("Linked identities")).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Providers" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("shows a connect note in People when there is no session", async () => {
    session.current = null;
    registerIdp(makeRecord());
    renderIdentity();
    expect(await screen.findByText("Sign in to see this")).toBeTruthy();
    expect(directory.getMe).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Connect to Identity/i }),
    );
    expect(connect).toHaveBeenCalled();
  });

  it("shows the me card and linked identities with a session", async () => {
    directory.listLinkedIdentities.mockResolvedValue([
      {
        id: "xid_1",
        kind: "oidc",
        issuer: "https://accounts.google.com",
        displayHint: "ada@example.com",
        assurance: "verified",
        linkedAt: "2026-08-03T00:00:00Z",
      },
    ]);
    registerIdp(makeRecord());
    renderIdentity();

    expect(await screen.findByText("Linked identities")).toBeTruthy();
    // The me card: state badge, assurance chip, copyable principal id.
    expect(screen.getByText("active")).toBeTruthy();
    // "verified" appears on both the me card and the identity row.
    expect(screen.getAllByText("verified").length).toBeGreaterThan(0);
    expect(screen.getByText("prn_op")).toBeTruthy();
    // The linked identity row.
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("https://accounts.google.com")).toBeTruthy();
  });

  it("flags a provisional principal as a guest nobody vouches for", async () => {
    directory.getMe.mockResolvedValue({
      id: "prn_guest",
      state: "provisional",
      assurance: "provisional",
      createdAt: "2026-08-01T00:00:00Z",
      version: 1,
    });
    registerIdp(makeRecord());
    renderIdentity();
    expect(await screen.findByText("Guest")).toBeTruthy();
    expect(
      screen.getByText(/No identity provider vouches for this identity yet/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Register an identity provider/i }),
    );
    expect(
      await screen.findByText("Connect your identity provider"),
    ).toBeTruthy();
  });

  it("unlinks an identity only after confirmation", async () => {
    directory.listLinkedIdentities.mockResolvedValue([
      {
        id: "xid_1",
        kind: "oidc",
        issuer: "https://accounts.google.com",
        displayHint: "ada@example.com",
        assurance: "verified",
        linkedAt: "2026-08-03T00:00:00Z",
      },
    ]);
    registerIdp(makeRecord());
    renderIdentity();
    await screen.findByText("ada@example.com");

    await userEvent.click(screen.getByRole("button", { name: /^Unlink$/i }));
    expect(directory.unlinkIdentity).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Unlink it/i }));
    await waitFor(() =>
      expect(directory.unlinkIdentity).toHaveBeenCalledWith("xid_1"),
    );
    expect(await screen.findByText(/was unlinked/)).toBeTruthy();
  });

  it("lists registry rows in Providers and removes the local mirror", async () => {
    registerIdp(
      makeRecord({
        id: "byo_1",
        issuer: "https://auth.example.dev",
        label: "Example IdP",
        kind: "byo",
        clientId: "cli_x",
      }),
    );
    renderIdentity();
    await openTab("Providers");

    expect(await screen.findByText("Example IdP")).toBeTruthy();
    expect(screen.getByText("Custom OIDC")).toBeTruthy();
    expect(screen.getByText("https://auth.example.dev")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(listIdpRegistrations()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Remove it/i }));
    expect(listIdpRegistrations()).toEqual([]);
    // The store updated and the banner posture returns.
    expect(
      await screen.findByText("No identity provider registered."),
    ).toBeTruthy();
  });

  it("badges preset rows with the preset label and monogram, legacy rows as Custom OIDC", async () => {
    registerIdp(
      makeRecord({
        id: "byo_workos",
        issuer: "https://api.workos.com",
        label: "WorkOS",
        kind: "byo",
        providerType: "workos",
        clientId: "cli_w",
      }),
    );
    registerIdp(
      makeRecord({
        id: "byo_legacy",
        issuer: "https://auth.example.dev",
        label: "Example IdP",
        kind: "byo",
        clientId: "cli_x",
      }),
    );
    const { container } = renderIdentity();
    await openTab("Providers");
    await screen.findByText("Example IdP");

    const chips = Array.from(container.querySelectorAll(".chip")).map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain("WorkOS");
    expect(chips).toContain("Custom OIDC");
    // The preset row's mark is the monogram tile; the legacy row keeps the
    // generic site icon.
    const monograms = Array.from(
      container.querySelectorAll(".identity-row__monogram"),
    ).map((tile) => tile.textContent);
    expect(monograms).toEqual(["W"]);
  });

  it("creates, rotates, and revokes OAuth clients in Service accounts", async () => {
    directory.listOAuthClients.mockResolvedValue([makeClient()]);
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Service accounts");

    expect(await screen.findByText("Release pipeline")).toBeTruthy();
    expect(screen.getByText("cli_1")).toBeTruthy();
    expect(screen.getByText("pre_registered")).toBeTruthy();

    // Create.
    await userEvent.type(
      screen.getByLabelText(/Display name/i),
      "Nightly sync",
    );
    await userEvent.type(
      screen.getByLabelText(/Redirect URIs/i),
      "https://sync.example.com/cb",
    );
    await userEvent.type(
      screen.getByLabelText(/Sector identifier/i),
      "https://sync.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    await waitFor(() =>
      expect(directory.createOAuthClient).toHaveBeenCalledWith({
        displayName: "Nightly sync",
        redirectUris: ["https://sync.example.com/cb"],
        sectorIdentifier: "https://sync.example.com",
      }),
    );

    // Rotate: the new client id is shown once, with copy.
    await userEvent.click(
      screen.getByRole("button", { name: /Rotate secret/i }),
    );
    await waitFor(() =>
      expect(directory.rotateOAuthClient).toHaveBeenCalledWith("cli_1"),
    );
    expect(
      await screen.findByText(/the new client id is shown once/),
    ).toBeTruthy();
    expect(screen.getByText("cli_3")).toBeTruthy();

    // Revoke, after confirmation.
    await userEvent.click(screen.getByRole("button", { name: /^Revoke$/i }));
    expect(directory.revokeOAuthClient).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Revoke it/i }));
    await waitFor(() =>
      expect(directory.revokeOAuthClient).toHaveBeenCalledWith("cli_1"),
    );

    // Agents are cross-linked, not duplicated.
    expect(screen.getByText("Agents")).toBeTruthy();
  });

  it("shows the empty service-identities state", async () => {
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Service accounts");
    expect(await screen.findByText("No service identities.")).toBeTruthy();
  });

  it("validates the org slug client-side before calling the API", async () => {
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Organization");

    await userEvent.type(screen.getByLabelText(/^Slug$/i), "Bad Slug!");
    await userEvent.type(screen.getByLabelText(/Display name/i), "Acme Corp");
    await userEvent.click(
      screen.getByRole("button", { name: /Create organization/i }),
    );
    expect(await screen.findByText(/Use a slug like acme-corp/)).toBeTruthy();
    expect(directory.createOrganization).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText(/^Slug$/i));
    await userEvent.type(screen.getByLabelText(/^Slug$/i), "acme-corp");
    await userEvent.click(
      screen.getByRole("button", { name: /Create organization/i }),
    );
    await waitFor(() =>
      expect(directory.createOrganization).toHaveBeenCalledWith({
        slug: "acme-corp",
        displayName: "Acme Corp",
      }),
    );
    expect(
      await screen.findByText(/Acme Corp was created — you are its owner/),
    ).toBeTruthy();
  });

  it("dismisses the ceremony into the banner posture, and re-opens it", async () => {
    renderIdentity();
    await screen.findByText("Connect your identity provider");

    await userEvent.click(screen.getByText("Set up later"));
    // The gate lifts onto the tabs; Providers carries the banner.
    await openTab("Providers");
    expect(
      await screen.findByText("No identity provider registered."),
    ).toBeTruthy();

    await userEvent.click(firstButton("Register an IdP"));
    expect(
      await screen.findByText("Connect your identity provider"),
    ).toBeTruthy();
  });

  it("approves a device from the Devices tab with a focused code field", async () => {
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Devices");

    const field = await screen.findByLabelText(/User code/i);
    expect(document.activeElement).toBe(field);
    await userEvent.type(field, "ABCD-EFGH");
    await userEvent.click(
      screen.getByRole("button", { name: /Approve device/i }),
    );

    await waitFor(() =>
      expect(directory.approveDevice).toHaveBeenCalledWith("ABCD-EFGH"),
    );
    expect(await screen.findByText("Device approved.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approve device/ })).toBeTruthy();
  });

  it("renders the unknown-code one-liner on a 404 from the Host", async () => {
    directory.approveDevice.mockRejectedValueOnce(
      new DirectoryError(
        404,
        "host_approval_failed",
        "No device is waiting on that code — check the code the device shows and try again.",
      ),
    );
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Devices");

    await userEvent.type(await screen.findByLabelText(/User code/i), "NOPE");
    await userEvent.click(
      screen.getByRole("button", { name: /Approve device/i }),
    );
    expect(
      await screen.findByText(/No device is waiting on that code/),
    ).toBeTruthy();
  });

  it("renders the unreachable one-liner when the Host is down", async () => {
    directory.approveDevice.mockRejectedValueOnce(
      new DirectoryError(
        502,
        "host_api_unreachable",
        "The Host is unreachable, so the approval could not be delivered. Start the Host and try again.",
      ),
    );
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Devices");

    await userEvent.type(await screen.findByLabelText(/User code/i), "CODE");
    await userEvent.click(
      screen.getByRole("button", { name: /Approve device/i }),
    );
    expect(await screen.findByText(/Host is unreachable/)).toBeTruthy();
  });

  it("renders the operator note when approval is unconfigured", async () => {
    directory.approveDevice.mockRejectedValueOnce(
      new DirectoryError(
        503,
        "operator_token_unconfigured",
        "Device approval is not enabled on this Identity service — the operator sets OPENSESAME_OPERATOR_TOKEN.",
      ),
    );
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Devices");

    await userEvent.type(await screen.findByLabelText(/User code/i), "CODE");
    await userEvent.click(
      screen.getByRole("button", { name: /Approve device/i }),
    );
    expect(
      await screen.findByText(/operator sets OPENSESAME_OPERATOR_TOKEN/),
    ).toBeTruthy();
  });

  it("shows a connect note in Devices when there is no session", async () => {
    session.current = null;
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Devices");
    expect(await screen.findByText("Sign in to see this")).toBeTruthy();
    expect(directory.approveDevice).not.toHaveBeenCalled();
  });

  it("lists only claimant rows in My access, with mode and expiry", async () => {
    access.listDelegations.mockResolvedValue([
      makeDelegation(),
      makeDelegation({
        id: "dlg_2",
        claimantSubject: "prn_someone_else",
        resources: ["repo:theirs"],
      }),
      makeDelegation({
        id: "dlg_3",
        resources: ["repo:dropped"],
        revokedAt: "2026-08-01T00:00:00Z",
      }),
    ]);
    registerIdp(makeRecord());
    renderIdentity();

    expect(await screen.findByText("My access")).toBeTruthy();
    expect(await screen.findByText("repo:opensesame")).toBeTruthy();
    expect(screen.getByText("conn_github")).toBeTruthy();
    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("broker")).toBeTruthy();
    expect(screen.getByText(/expires in/)).toBeTruthy();
    // Grants I minted for others and dropped grants stay out.
    expect(screen.queryByText("repo:theirs")).toBeNull();
    expect(screen.queryByText("repo:dropped")).toBeNull();
  });

  it("drops a grant only after confirmation", async () => {
    access.listDelegations.mockResolvedValue([makeDelegation()]);
    registerIdp(makeRecord());
    renderIdentity();
    await screen.findByText("repo:opensesame");

    await userEvent.click(screen.getByRole("button", { name: /^Drop$/i }));
    expect(access.revokeDelegation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Drop it/i }));
    await waitFor(() =>
      expect(access.revokeDelegation).toHaveBeenCalledWith("dlg_1"),
    );
    expect(await screen.findByText("Access dropped.")).toBeTruthy();
  });

  it("shows the one-line empty state in My access", async () => {
    registerIdp(makeRecord());
    renderIdentity();
    expect(await screen.findByText("My access")).toBeTruthy();
    expect(
      await screen.findByText(
        /No access held — claim a code an owner hands you/,
      ),
    ).toBeTruthy();
  });

  it("claims an offered grant through the ceremony and lists it", async () => {
    access.listDelegations
      .mockResolvedValueOnce([])
      .mockResolvedValue([makeDelegation({ id: "dlg_9" })]);
    presentOffer.mockResolvedValue({
      id: "off_1",
      state: "presented",
      manifestDigest: "sha256:abc",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      items: [
        {
          id: "item_1",
          connectionId: "conn_github",
          providerId: "github",
          displayName: "GitHub prod",
          actions: ["read"],
          resources: ["repo:opensesame"],
          expiresInSeconds: 3600,
          executionMode: "broker",
          required: true,
          dependencies: [],
        },
        {
          id: "item_2",
          connectionId: "conn_github",
          providerId: "github",
          displayName: "GitHub prod issues",
          actions: ["write"],
          resources: ["repo:opensesame/issues"],
          expiresInSeconds: 3600,
          executionMode: "broker",
          required: false,
          dependencies: [],
        },
      ],
    });
    access.claimDelegation.mockResolvedValue([makeDelegation({ id: "dlg_9" })]);
    registerIdp(makeRecord());
    renderIdentity();
    expect(await screen.findByText(/No access held/)).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: /Claim access/i }),
    );
    const token = await screen.findByLabelText(/Claim token/i);
    expect(document.activeElement).toBe(token);
    await userEvent.type(token, "osc_clm_id.secret");
    await userEvent.type(screen.getByLabelText(/User code/i), "WORD-WORD");
    await userEvent.click(
      screen.getByRole("button", { name: /Review offer/i }),
    );

    // Present shows the offered scope before anything is accepted.
    await waitFor(() =>
      expect(presentOffer).toHaveBeenCalledWith("osc_clm_id.secret"),
    );
    expect(await screen.findByText("GitHub prod")).toBeTruthy();
    expect(screen.getByText("repo:opensesame/issues")).toBeTruthy();
    expect(access.claimDelegation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Accept$/i }));
    await waitFor(() =>
      expect(access.claimDelegation).toHaveBeenCalledWith({
        claimToken: "osc_clm_id.secret",
        userCode: "WORD-WORD",
        acceptedItemIds: ["item_1", "item_2"],
      }),
    );
    // The ceremony closes and the new grant is simply there.
    expect(await screen.findByRole("button", { name: /^Drop$/i })).toBeTruthy();
    expect(screen.getByText("My access")).toBeTruthy();
  });

  it("backs out of the claim ceremony without claiming", async () => {
    registerIdp(makeRecord());
    renderIdentity();
    expect(await screen.findByText("My access")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: /Claim access/i }),
    );
    await screen.findByLabelText(/Claim token/i);
    await userEvent.click(screen.getByRole("button", { name: /^Back$/i }));

    expect(presentOffer).not.toHaveBeenCalled();
    expect(access.claimDelegation).not.toHaveBeenCalled();
    expect(await screen.findByText(/No access held/)).toBeTruthy();
  });

  it("registers a second and third IdP without re-gating", async () => {
    listFederatedProviders.mockResolvedValue([
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
      { id: "github", label: "GitHub", kind: "oidc", browserCapable: false },
    ]);
    // A BYO record always lists; first-class rows are catalog-intersected.
    registerIdp(
      makeRecord({
        id: "byo_0",
        label: "Shoo",
        kind: "byo",
        issuer: "https://shoo.dev",
        clientId: "cli_0",
      }),
    );
    renderIdentity();
    await openTab("Providers");
    expect(await screen.findByText("Shoo")).toBeTruthy();

    // Second registration: the ceremony opens from the tab and appends.
    await userEvent.click(firstButton("Register an IdP"));
    await screen.findByText("Connect your identity provider");
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue with Google" }),
    );
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Google now vouches for sign-ins on this device/),
    ).toBeTruthy();
    expect(listIdpRegistrations()).toHaveLength(2);

    // Third: same path, registry still appends, and the tabs never re-gate.
    await userEvent.click(firstButton("Register an IdP"));
    await screen.findByText("Connect your identity provider");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/GitHub now vouches for sign-ins on this device/),
    ).toBeTruthy();
    expect(listIdpRegistrations()).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByText("Connect your identity provider")).toBeNull();
  });

  it("keeps every tab within the one-sentence prose budget", async () => {
    registerIdp(makeRecord());
    const { container } = renderIdentity();

    await screen.findByText("prn_op");
    await screen.findByText(/No access held/);
    expectProseBudget(container);

    await openTab("Providers");
    await screen.findByText("Who vouches for them");
    expectProseBudget(container);

    await openTab("Devices");
    await screen.findByLabelText(/User code/i);
    expectProseBudget(container);

    await openTab("Service accounts");
    await screen.findByText("No service identities.");
    expectProseBudget(container);

    await openTab("Organization");
    await screen.findByText("No organizations yet");
    expectProseBudget(container);
  });

  it("keeps the ceremony within the one-sentence prose budget", async () => {
    const { container } = renderIdentity();
    await screen.findByText("Connect your identity provider");
    expectProseBudget(container);
  });
});
