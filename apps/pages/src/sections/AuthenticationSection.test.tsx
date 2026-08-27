import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identitySeams } from "../lib/identity.js";
import {
  AuthenticationSection,
  authenticationSectionSeams,
} from "./AuthenticationSection.js";

const application = {
  id: "authapp_pages",
  ownerPrincipalId: "prn_pages",
  organizationId: null,
  displayName: "Pages",
  rpId: window.location.hostname,
  origins: [window.location.origin],
  secretPrefix: "osa_example",
  apiKeys: [
    {
      id: "authkey_pages",
      secretPrefix: "osa_example",
      state: "active" as const,
      createdAt: "2026-08-26T12:00:00.000Z",
    },
  ],
  configurations: [
    {
      purpose: "sign-in",
      timeToLiveSeconds: 120,
      userVerification: "preferred" as const,
      hints: [],
    },
    {
      purpose: "step-up",
      timeToLiveSeconds: 180,
      userVerification: "required" as const,
      hints: [],
    },
  ],
  manualTokensEnabled: false,
  magicLinksEnabled: false,
  state: "active" as const,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

describe("AuthenticationSection", () => {
  const originalIdentity = { ...identitySeams };
  const originalAuthentication = { ...authenticationSectionSeams };

  beforeEach(() => {
    Object.assign(identitySeams, {
      useIdentitySession: () => ({
        principalId: "prn_pages",
        accessToken: "pst_pages",
        issuerOrigin: "http://127.0.0.1:8788",
      }),
      useConnect: () => ({ connecting: false, error: null, connect: vi.fn() }),
    });
    Object.assign(authenticationSectionSeams, {
      listAuthenticationApplications: vi.fn(async () => [application]),
      listOrgMemberships: vi.fn(async () => []),
      listAuthenticationUsers: vi.fn(async () => []),
      listAuthenticationEvents: vi.fn(async () => []),
      listAuthenticationOrganizationEvents: vi.fn(async () => []),
      registerPwaPasskey: vi.fn(async () => ({ ok: true })),
      signinWithAuthenticationService: vi.fn(async () => ({
        token: "ost_result",
        expiresAt: "2026-08-26T12:02:00.000Z",
      })),
    });
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: class PublicKeyCredential {},
    });
  });

  afterEach(() => {
    cleanup();
    Object.assign(identitySeams, originalIdentity);
    Object.assign(authenticationSectionSeams, originalAuthentication);
    Reflect.deleteProperty(window, "PublicKeyCredential");
  });

  it("exposes application administration and runs the shared PWA ceremony", async () => {
    render(<AuthenticationSection />);
    expect(await screen.findByText("Free and self-hostable")).toBeTruthy();
    expect(screen.getByText("Pages · localhost")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("User name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Alias"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Register passkey/ }));

    await waitFor(() => {
      expect(
        authenticationSectionSeams.registerPwaPasskey,
      ).toHaveBeenCalledWith({
        applicationId: "authapp_pages",
        userName: "Ada",
        alias: "ada@example.com",
        credentialName: "This device",
      });
    });
    expect(
      await screen.findByText(
        "Passkey registered through the shared browser client.",
      ),
    ).toBeTruthy();
  });
});
