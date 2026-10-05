import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/** @vitest-environment jsdom */
import { identityHookSeams } from "../../bindings/identity.js";

import type {
  OperatorIdp,
  PagesSettings,
} from "@opensesame/app-core/lib/settings.js";
import {
  defaultSignInMethods,
  settingsSeams,
} from "@opensesame/app-core/lib/settings.js";

/**
 * Setup is the allowlist, and this screen is where that has to be true.
 *
 * It used to offer every road it could name — the compiled broker, a
 * bring-your-own globe, a magic link, an organisation lookup — whether or not
 * the deployment had anything behind them. Most of those need an Identity
 * API, so on a deployment without one they were buttons that could only fail.
 * ADR 0078 §3: the screen renders what first-run setup allowed and nothing
 * else. The local-only seal is the standing exception: it seals a local vault
 * and needs no service.
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

import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
Object.assign(identitySeams, {
  identityBase: () => state.identityApi,
});
Object.assign(identityHookSeams, {
  useIdentitySession: () => null,
});
Object.assign(deviceIdentitySeams, {
  remoteIdentityApi: () => state.identityApi,
});

import type { TrustedUpstream } from "@opensesame/app-core/lib/federation.js";
import { federationSeams } from "@opensesame/app-core/lib/federation.js";
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

import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
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

function ensureLocalStorage(): Storage {
  const existing = globalThis.localStorage;
  if (existing) return existing;
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return storage;
}

beforeEach(() => {
  state.identityApi = "";
  state.signIn = defaultSignInMethods();
  beginSignIn.mockClear();
  ensureLocalStorage().clear();
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
    // organisation lookup are Identity API ceremonies. The local-only seal
    // does not need one, and is asserted below.
    expect(
      screen.queryByRole("button", { name: "Continue with your IdP" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More sign-in options" }),
    ).toBeNull();
    expect(screen.queryByLabelText(/Email or organization/i)).toBeNull();
  });

  it("offers the local-only seal without an identity service", () => {
    // The seal needs no service at all. It is the panel's single no-account
    // road; guest has its own placements elsewhere (AGENTS.md §5).
    renderPanel();
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeDefined();
  });

  it("is the local-only seal a tutorial points at (unlock.local-only, ADR 0166)", () => {
    renderPanel();
    expect(resolveGuideTargetElement("unlock.local-only")).toBe(
      screen.getByRole("button", { name: "Use without an account" }),
    );
  });

  it("brings the service roads back the moment one is configured", () => {
    state.identityApi = "https://id.acme.com";
    renderPanel();
    expect(
      screen.getByRole("button", { name: "Continue with your IdP" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "More sign-in options" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeDefined();
  });

  it("offers no no-account road beside an existing vault", () => {
    render(<SignInPanel placement="secondary" providers={[]} />);
    // Local-only would seal a second vault in place. Guest is not this
    // panel's to offer: the unlock form's own footer carries it.
    expect(
      screen.queryByRole("button", { name: "Use without an account" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Continue as guest/ }),
    ).toBeNull();
  });

  it("keeps the local-only seal even when setup allowed nothing", () => {
    state.signIn = { builtin: false, providers: [] };
    renderPanel();
    const bar = document.querySelector(".signin__bar");
    expect(bar?.querySelectorAll("button")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeDefined();
  });
});

describe("SignInPanel — where the keyboard lands", () => {
  it("lands on the first road in when there is no identifier field to take it", () => {
    // No Identity API: no identifier field, so nothing else claims the caret.
    // The first brand mark in the social bar is the first road, and Enter
    // starts it — the screen is answerable without a click.
    renderPanel();
    const first = screen.getByRole("button", { name: /Continue with/ });
    expect(document.activeElement).toBe(first);
  });

  it("leaves the keyboard where it is when setup left no provider at all", () => {
    state.signIn = { ...defaultSignInMethods(), builtin: false, providers: [] };
    renderPanel();
    // Nothing in the bar to land on; the local-only seal below the bar is the
    // only road, and Tab reaches it.
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeDefined();
  });

  it("yields to the identifier field where an identity service exists", () => {
    state.identityApi = "http://127.0.0.1:18788";
    renderPanel();
    expect(document.activeElement).toBe(
      screen.getByLabelText(/Email or organization/i),
    );
  });
});

describe("SignInPanel — last used 3P method", () => {
  it("rings the last-used provider and names it under the bar", () => {
    localStorage.setItem("opensesame:federation:last-method", "google");
    renderPanel();
    const google = screen.getByRole("button", {
      name: "Continue with Google · last used",
    });
    expect(google.getAttribute("aria-current")).toBe("true");
    expect(google.className).toContain("is-last");
    expect(screen.getByText("Last used · Google")).toBeTruthy();
  });

  it("promotes a last-used catalog provider in front of the others", () => {
    localStorage.setItem("opensesame:federation:last-method", "github");
    render(
      <SignInPanel
        placement="primary"
        providers={[
          {
            id: "google",
            label: "Google",
            kind: "oidc",
            browserCapable: true,
          },
          {
            id: "github",
            label: "GitHub",
            kind: "oauth2",
            browserCapable: false,
          },
        ]}
        onUseLocalOnly={vi.fn()}
      />,
    );
    const bar = document.querySelector(".signin__bar");
    const labels = [...(bar?.querySelectorAll("button") ?? [])].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels[0]).toBe("Continue with GitHub · last used");
    expect(labels[1]).toBe("Continue with Google");
  });
});
