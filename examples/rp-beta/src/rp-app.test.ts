import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpApp } from "./RpApp.js";
import { type Session, sdkBrowserSeams } from "./sdk-browser.js";

const mocks = {
  createOpenSesame: vi.fn(),
  handleRedirectCallback: vi.fn(),
  getSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
};

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  name: "RP Beta",
  clientId: "rp-beta",
  sector: "https://beta.example.test",
  port: 5175,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "at",
    anonymous: false,
    raw: { access_token: "at", token_type: "Bearer" },
    ...overrides,
  };
}

function demoDigest(sector: string): string {
  return Array.from(new TextEncoder().encode(`${sector}:demo-principal`))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

let container: HTMLDivElement;
let root: Root;

async function renderApp(appProps: typeof props = props) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(RpApp, appProps));
  });
  return container;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: BoundaryValue) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function bindSeams(): void {
  sdkBrowserSeams.createOpenSesame = mocks.createOpenSesame;
  mocks.createOpenSesame.mockReturnValue({
    handleRedirectCallback: mocks.handleRedirectCallback,
    getSession: mocks.getSession,
    signIn: mocks.signIn,
    signOut: mocks.signOut,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bindSeams();
  mocks.getSession.mockResolvedValue(null);
  mocks.signIn.mockResolvedValue(undefined);
  mocks.signOut.mockResolvedValue(undefined);
  window.history.replaceState(null, "", "/");
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllEnvs();
});

describe("RpApp", () => {
  it("configures the SDK client with issuer, client id, and loopback redirect", async () => {
    await renderApp();
    expect(mocks.createOpenSesame).toHaveBeenCalledWith({
      issuer: "http://127.0.0.1:8788",
      clientId: "rp-beta",
      redirectUri: "http://127.0.0.1:5175/",
    });
  });

  it("honours a VITE_OPENSESAME_ISSUER override", async () => {
    vi.stubEnv("VITE_OPENSESAME_ISSUER", "https://id.example.test");
    vi.resetModules();
    const { sdkBrowserSeams: seams } = await import("./sdk-browser.js");
    seams.createOpenSesame = mocks.createOpenSesame;
    const { RpApp: RpAppWithEnv } = await import("./RpApp.js");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(RpAppWithEnv, props));
    });
    expect(mocks.createOpenSesame).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "https://id.example.test" }),
    );
    vi.resetModules();
  });

  it("renders the relying-party identity from its props", async () => {
    await renderApp();
    expect(container.textContent).toContain("RP Beta");
    expect(container.textContent).toContain("rp-beta");
    expect(container.textContent).toContain("https://beta.example.test");
    expect(container.textContent).toContain("Canonical principal ids");
  });

  it("shows the signed-out panel when no session exists", async () => {
    await renderApp();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Signed out.");
  });

  it("shows the pairwise sub for an existing session", async () => {
    mocks.getSession.mockResolvedValue(session({ sub: "pw_beta123" }));
    await renderApp();
    expect(container.textContent).toContain("pw_beta123");
    expect(container.textContent).not.toContain("Signed out.");
  });

  it("falls back to an opaque-token label when the session has no sub", async () => {
    mocks.getSession.mockResolvedValue(session());
    await renderApp();
    expect(container.textContent).toContain("present (opaque token)");
  });

  it("completes the redirect callback and strips the code from the URL", async () => {
    window.history.replaceState(null, "", "/?code=abc&state=xyz");
    const callbackUrl = window.location.href;
    mocks.handleRedirectCallback.mockResolvedValue(
      session({ sub: "pw_from_callback" }),
    );
    await renderApp();
    expect(mocks.handleRedirectCallback).toHaveBeenCalledWith(callbackUrl);
    expect(container.textContent).toContain("pw_from_callback");
    expect(window.location.search).toBe("");
  });

  it("disables actions and shows progress while completing sign-in", async () => {
    window.history.replaceState(null, "", "/?code=abc");
    const pending = deferred<Session>();
    mocks.handleRedirectCallback.mockReturnValue(pending.promise);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(RpApp, props));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Completing sign-in…");
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
    await act(async () => {
      pending.resolve(session({ sub: "pw_late" }));
    });
    expect(container.textContent).toContain("pw_late");
  });

  it("surfaces Error messages from a failed callback", async () => {
    window.history.replaceState(null, "", "/?code=bad");
    mocks.handleRedirectCallback.mockRejectedValue(
      new Error("OAuth state mismatch"),
    );
    await renderApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "OAuth state mismatch",
    );
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(false);
    }
  });

  it("uses a generic message for non-Error callback failures", async () => {
    window.history.replaceState(null, "", "/?code=bad");
    mocks.handleRedirectCallback.mockRejectedValue("network gone");
    await renderApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Sign-in callback failed. Try signing in again.",
    );
  });

  it("derives a deterministic sector-specific mock pairwise sub", async () => {
    await renderApp();
    const demoButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Demo pairwise sub"),
    );
    await act(async () => {
      demoButton?.click();
    });
    expect(container.textContent).toContain(`pw_${demoDigest(props.sector)}`);
  });

  it("starts sign-in from the primary action", async () => {
    await renderApp();
    const signInButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign in",
    );
    await act(async () => {
      signInButton?.click();
    });
    expect(mocks.signIn).toHaveBeenCalledOnce();
  });

  it("sign-out clears session and mock sub, then delegates to the SDK", async () => {
    mocks.getSession.mockResolvedValue(session({ sub: "pw_beta123" }));
    await renderApp();
    const demoButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Demo pairwise sub"),
    );
    await act(async () => {
      demoButton?.click();
    });
    expect(container.textContent).toContain("Mock verified pairwise sub:");
    const signOutButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign out",
    );
    await act(async () => {
      signOutButton?.click();
    });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("pw_beta123");
    expect(container.textContent).toContain("Signed out.");
  });
});
