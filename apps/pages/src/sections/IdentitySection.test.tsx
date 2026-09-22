import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { IdentitySession } from "../lib/identity.js";
import type { IdpRecord } from "../lib/idp-registry.js";
import { IDENTITY_VIEWS } from "../lib/section-views.js";
import { declareTutorialForTest } from "../modules/tutorial-test-realm.js";
import {
  IDENTITY_ROUTES,
  IDENTITY_TARGETS,
} from "../tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "../tutorial/registry/identity-goals.js";
import { contributeIdentityViews } from "./identity/identity-views.js";
import { expectProseBudget, makeClient } from "./identity/test-fixtures.js";
import {
  ByoError,
  DirectoryError,
  activeOrgProfileId,
  beginSignIn,
  connect,
  deviceIdentitySeams,
  directory,
  listFederatedProviders,
  listOrgMemberships,
  online,
  originalRemoteIdentityApi,
  registerByoProvider,
  registry,
  session,
} from "./identity/test-seams.js";

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

function renderIdentity() {
  return render(
    <MemoryRouter>
      <IdentitySection />
    </MemoryRouter>,
  );
}

async function openProviderCeremony() {
  await openTab("Providers");
  await userEvent.click(firstButton("Register an IdP"));
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
  // The Identity tabs belong to three capabilities (local IAM, federation,
  // directory provisioning), and each contributes its own view. These cases
  // describe a deployment that approved them, so they register the same
  // contributions the modules make at activation.
  let revokeIdentityViews: (() => void) | null = null;
  let undeclareTutorial: (() => void) | null = null;
  beforeEach(async () => {
    revokeIdentityViews = contributeIdentityViews(IDENTITY_VIEWS);
    undeclareTutorial = await declareTutorialForTest("identity.federation", {
      targets: IDENTITY_TARGETS,
      goals: IDENTITY_GOALS,
      routes: IDENTITY_ROUTES,
    });
  });
  afterEach(() => {
    undeclareTutorial?.();
    undeclareTutorial = null;
    revokeIdentityViews?.();
    revokeIdentityViews = null;
  });

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
    deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:8788";

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
    deviceIdentitySeams.remoteIdentityApi = originalRemoteIdentityApi;
  });

  it("opens administration without an upstream binding and offers an explicit provider ceremony", async () => {
    renderIdentity();
    expect(screen.getByRole("tab", { name: "People" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Applications" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByText("Connect your identity provider")).toBeNull();
    await openProviderCeremony();
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
    await openProviderCeremony();
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
      expect.objectContaining({ id: "opensesame-device", kind: "device" }),
      expect.objectContaining({ id: "google", kind: "first-class" }),
    ]);
    // The gate lifts onto the Providers tab with the success line.
    expect(await screen.findByText(/Sign-in started with Google/)).toBeTruthy();
  });

  it("runs the custom OIDC card two-step on registration_unsupported", async () => {
    registerByoProvider.mockRejectedValueOnce(
      new ByoError(
        "registration_unsupported",
        "This provider cannot register clients automatically — create one there and enter its details.",
      ),
    );
    renderIdentity();
    await openProviderCeremony();
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
      expect.objectContaining({ id: "opensesame-device", kind: "device" }),
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
    await openProviderCeremony();
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
      expect.objectContaining({ id: "opensesame-device", kind: "device" }),
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
    await openProviderCeremony();
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
      expect.objectContaining({ id: "opensesame-device", kind: "device" }),
      expect.objectContaining({ kind: "byo", providerType: "workos" }),
    ]);
  });

  it("validates the Better Auth URL client-side before registering", async () => {
    renderIdentity();
    await openProviderCeremony();
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
      expect.objectContaining({ id: "opensesame-device", kind: "device" }),
      expect.objectContaining({ kind: "byo", providerType: "better-auth" }),
    ]);
  });

  it("returns from a preset form to the preset tiles on Back", async () => {
    renderIdentity();
    await openProviderCeremony();
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
      "Applications",
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
    expect(
      await screen.findByText("Connect to manage identities"),
    ).toBeTruthy();
    expect(directory.getMe).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    expect(connect).toHaveBeenCalled();
  });

  it.skip("shows the me card and linked identities with a session", async () => {
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

  it.skip("flags a provisional principal as Guest without demanding another IdP", async () => {
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
      screen.queryByText(/No identity provider vouches for this identity yet/),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Register an identity provider/i }),
    ).toBeNull();
  });

  it.skip("unlinks an identity only after confirmation", async () => {
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
    expect(listIdpRegistrations()).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /Remove it/i }));
    expect(listIdpRegistrations()).toEqual([
      expect.objectContaining({ id: "opensesame-device", kind: "device" }),
    ]);
    // Device IdP remains — never an empty "no provider" posture.
    expect(await screen.findByText("OpenSesame (this device)")).toBeTruthy();
    expect(screen.queryByText("No identity provider registered.")).toBeNull();
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

  it("creates, rotates, and revokes OAuth clients in Applications", async () => {
    directory.listOAuthClients.mockResolvedValue([makeClient()]);
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Applications");

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

    // Rotate: the new client id is displayed with copy.
    await userEvent.click(
      screen.getByRole("button", { name: /Rotate client ID/i }),
    );
    await waitFor(() =>
      expect(directory.rotateOAuthClient).toHaveBeenCalledWith("cli_1"),
    );
    expect(await screen.findByText(/the new client id:/)).toBeTruthy();
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
    await openTab("Applications");
    expect(await screen.findByText("No applications registered.")).toBeTruthy();
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

  it("dismisses the ceremony onto Providers with the device IdP still listed", async () => {
    renderIdentity();
    await openProviderCeremony();
    await screen.findByText("Connect your identity provider");

    await userEvent.click(screen.getByText("Set up later"));
    await openTab("Providers");
    expect(await screen.findByText("OpenSesame (this device)")).toBeTruthy();
    expect(screen.queryByText("No identity provider registered.")).toBeNull();

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
        "Approval could not be delivered. Try again when the service is reachable.",
      ),
    );
    registerIdp(makeRecord());
    renderIdentity();
    await openTab("Devices");

    await userEvent.type(await screen.findByLabelText(/User code/i), "CODE");
    await userEvent.click(
      screen.getByRole("button", { name: /Approve device/i }),
    );
    expect(await screen.findByText(/could not be delivered/)).toBeTruthy();
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
    expect(
      await screen.findByText("Connect to manage identities"),
    ).toBeTruthy();
    expect(directory.approveDevice).not.toHaveBeenCalled();
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
    expect(await screen.findByText(/Sign-in started with Google/)).toBeTruthy();
    expect(listIdpRegistrations()).toHaveLength(3);

    // Third: same path, registry still appends, and the tabs never re-gate.
    await userEvent.click(firstButton("Register an IdP"));
    await screen.findByText("Connect your identity provider");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Sign-in started with GitHub/)).toBeTruthy();
    expect(listIdpRegistrations()).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByText("Connect your identity provider")).toBeNull();
  });

  it("keeps every tab within the one-sentence prose budget", async () => {
    registerIdp(makeRecord());
    const { container } = renderIdentity();

    await screen.findByText("prn_op");
    await screen.findByText("You");
    expectProseBudget(container);

    await openTab("Providers");
    await screen.findByText("Who vouches for them");
    await screen.findByText("OpenSesame (this device)");
    expectProseBudget(container);

    await openTab("Devices");
    await screen.findByLabelText(/User code/i);
    expectProseBudget(container);

    await openTab("Applications");
    await screen.findByText("No applications registered.");
    expectProseBudget(container);

    await openTab("Organization");
    await screen.findByText("No organizations yet");
    expectProseBudget(container);
  });

  it("keeps the ceremony within the one-sentence prose budget", async () => {
    const { container } = renderIdentity();
    await openProviderCeremony();
    await screen.findByText("Connect your identity provider");
    expectProseBudget(container);
  });
});
