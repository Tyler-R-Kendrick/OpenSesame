import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OperatorIdp, PagesSettings } from "../../lib/settings.js";
import { defaultSignInMethods, settingsSeams } from "../../lib/settings.js";

/**
 * Setup is the allowlist, and this screen is where that has to be true.
 *
 * It used to offer every road it could name — the compiled broker, a
 * bring-your-own globe, a magic link, an organisation lookup — whether or not
 * the deployment had anything behind them. Most of those need an Identity
 * API, so on a deployment without one they were buttons that could only fail.
 * ADR 0078 §3: the screen renders what first-run setup allowed and nothing
 * else. Guest is the standing exception: it seals a local vault, needs no
 * service, and is never removed or gated (AGENTS.md §5).
 */

const state = {
  identityApi: "",
  signIn: defaultSignInMethods(),
};

const originalSettingsSeams = { ...settingsSeams };

Object.assign(settingsSeams, {
  loadSettings: (): PagesSettings => ({
    ...originalSettingsSeams.loadSettings(),
    identityApi: state.identityApi,
    signIn: state.signIn,
  }),
});

import { identitySeams } from "../../lib/identity.js";
Object.assign(identitySeams, {
  identityBase: () => state.identityApi,
  useIdentitySession: () => null,
});

import type { TrustedUpstream } from "../../lib/federation.js";
import { federationSeams } from "../../lib/federation.js";
const beginSignIn = vi.fn((_upstream: TrustedUpstream) => Promise.resolve());
Object.assign(federationSeams, {
  beginSignIn,
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google",
  }),
  loadSession: () => null,
});

import { SignInPanel } from "./SignInPanel.js";

function idp(overrides: Partial<OperatorIdp> = {}): OperatorIdp {
  return {
    providerId: "okta",
    issuer: "https://acme.okta.com",
    clientId: "0oa1b2c3d4EXAMPLE",
    label: "Okta",
    ...overrides,
  };
}

beforeEach(() => {
  state.identityApi = "";
  state.signIn = defaultSignInMethods();
  beginSignIn.mockClear();
});

afterEach(cleanup);

function renderPanel() {
  return render(
    <SignInPanel placement="primary" providers={[]} onUseLocalOnly={vi.fn()} />,
  );
}

describe("what the sign-in screen offers", () => {
  it("offers the compiled-in broker while setup keeps it", () => {
    renderPanel();
    expect(
      screen.getByRole("button", {
        name: "Continue with Google",
      }),
    ).toBeDefined();
  });

  it("drops the compiled-in broker once setup removes it", () => {
    state.signIn = { builtin: false, providers: [] };
    renderPanel();
    expect(
      screen.queryByRole("button", {
        name: "Continue with Google",
      }),
    ).toBeNull();
  });

  it("offers every provider setup configured, in that order", () => {
    state.signIn = {
      builtin: false,
      providers: [
        idp({
          providerId: "google",
          issuer: "https://accounts.google.com",
          label: "Google",
        }),
        idp(),
      ],
    };
    renderPanel();
    const bar = document.querySelector(".signin__bar");
    const labels = [...(bar?.querySelectorAll("button") ?? [])].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Continue with Google", "Continue with Okta"]);
  });

  it("starts the operator's own provider against its own issuer", () => {
    state.signIn = { builtin: false, providers: [idp()] };
    renderPanel();
    screen.getByRole("button", { name: "Continue with Okta" }).click();
    expect(beginSignIn.mock.calls[0]?.[0]).toMatchObject({
      issuer: "https://acme.okta.com",
      clientId: "0oa1b2c3d4EXAMPLE",
    });
  });

  it("hides every road that needs an identity service, when there is none", () => {
    renderPanel();
    // Bring-your-own registers server-side; the magic link and the
    // organisation lookup are Identity API ceremonies. Guest is NOT — it
    // stays, asserted separately below.
    expect(
      screen.queryByRole("button", { name: "Continue with your IdP" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More sign-in options" }),
    ).toBeNull();
    expect(screen.queryByLabelText(/Email or organization/i)).toBeNull();
  });

  it("offers guest even without an identity service (AGENTS.md §5)", () => {
    // `continueAsGuest` seals a local vault and works with no service at all;
    // the claim step degrades to a bell notice. The guest/anonymous flow must
    // never be removed from this screen or gated on Identity availability.
    renderPanel();
    expect(
      screen.getByRole("button", { name: /Continue as guest/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    ).toBeDefined();
  });

  it("brings those roads back the moment one is configured", () => {
    state.identityApi = "https://id.acme.com";
    renderPanel();
    expect(
      screen.getByRole("button", { name: "Continue with your IdP" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "More sign-in options" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Continue as guest/ }),
    ).toBeDefined();
  });

  it("offers guest beside an existing vault too (AGENTS.md §5)", () => {
    render(<SignInPanel placement="secondary" providers={[]} />);
    expect(
      screen.getByRole("button", { name: /Continue as guest/ }),
    ).toBeDefined();
    // Local-only would seal a second vault in place, so that road stays off.
    expect(
      screen.queryByRole("button", { name: "Use without an account" }),
    ).toBeNull();
  });

  it("keeps guest and local-only even when setup allowed nothing", () => {
    state.signIn = { builtin: false, providers: [] };
    renderPanel();
    const bar = document.querySelector(".signin__bar");
    expect(bar?.querySelectorAll("button")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /Continue as guest/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeDefined();
  });
});
