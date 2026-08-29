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
}));

import { directorySeams } from "../lib/directory.js";
Object.assign(directorySeams, directory);

const listOrgMemberships = vi.hoisted(() => vi.fn());
const activeOrgProfileId = vi.hoisted(() => vi.fn());

import { orgSeams } from "../lib/orgs.js";
Object.assign(orgSeams, { listOrgMemberships, activeOrgProfileId });

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
    // Branded first-class buttons from the catalog, and the custom-OIDC card
    // with the issuer field focused on mount.
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    const issuer = screen.getByLabelText(/Custom OIDC issuer/i);
    expect(document.activeElement).toBe(issuer);
    expect(screen.getByText("Set up later")).toBeTruthy();
    // No tabs behind the gate.
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("records a first-class provider and starts the brokered leg in one gesture", async () => {
    renderIdentity();
    await screen.findByText("Connect your identity provider");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
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

  it("renders one tab at a time with aria-selected once the gate is lifted", async () => {
    registerIdp(makeRecord());
    renderIdentity();

    for (const name of [
      "People",
      "Providers",
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
      await screen.findByText("No identity provider registered yet"),
    ).toBeTruthy();
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
    expect(screen.getByText("Agents live in Access")).toBeTruthy();
  });

  it("shows the empty service-identities state", async () => {
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Service accounts");
    expect(await screen.findByText("No service identities yet")).toBeTruthy();
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
      await screen.findByText("No identity provider registered yet"),
    ).toBeTruthy();

    await userEvent.click(firstButton("Register an IdP"));
    expect(
      await screen.findByText("Connect your identity provider"),
    ).toBeTruthy();
  });
});
