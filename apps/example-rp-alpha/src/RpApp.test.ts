import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";
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

(
  overlapCast(globalThis)
).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  name: "RP Alpha",
  clientId: "rp-alpha",
  sector: "https://alpha.example.test",
  port: 5174,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "at",
    anonymous: false,
    raw: { access_token: "at", token_type: "Bearer" },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function renderApp() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(RpApp, props));
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

beforeEach(() => {
  vi.clearAllMocks();
  sdkBrowserSeams.createOpenSesame = mocks.createOpenSesame;
  mocks.createOpenSesame.mockReturnValue({
    handleRedirectCallback: mocks.handleRedirectCallback,
    getSession: mocks.getSession,
    signIn: mocks.signIn,
    signOut: mocks.signOut,
  });
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
});

describe("RpApp", () => {
  it("shows the signed-out panel when no session exists", async () => {
    await renderApp();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Signed out.");
    expect(container.textContent).toContain(`client_id=${props.clientId}`);
    expect(container.textContent).toContain(`sector=${props.sector}`);
  });

  it("shows the pairwise sub for an existing session", async () => {
    mocks.getSession.mockResolvedValue(session({ sub: "pw_alpha" }));
    await renderApp();
    expect(container.textContent).toContain("Session pairwise sub:");
    expect(container.textContent).toContain("pw_alpha");
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
    mocks.handleRedirectCallback.mockResolvedValue(session({ sub: "pw_cb" }));
    await renderApp();
    expect(mocks.handleRedirectCallback).toHaveBeenCalledWith(callbackUrl);
    expect(container.textContent).toContain("pw_cb");
    expect(window.location.search).toBe("");
  });

  it("disables actions and shows progress while completing sign-in", async () => {
    window.history.replaceState(null, "", "/?code=abc");
    const pending = deferred<Session>();
    mocks.handleRedirectCallback.mockReturnValue(pending.promise);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Flush only the synchronous render + effect start, not the callback.
    await act(async () => {
      root.render(createElement(RpApp, props));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Completing sign-in…");
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }

    await act(async () => {
      pending.resolve(session({ sub: "pw_late" }));
    });
    expect(container.textContent).toContain("pw_late");
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(false);
    }
  });

  it("surfaces Error messages from a failed callback", async () => {
    window.history.replaceState(null, "", "/?code=bad");
    mocks.handleRedirectCallback.mockRejectedValue(new Error("token expired"));
    await renderApp();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("token expired");
  });

  it("uses a generic message for non-Error callback failures", async () => {
    window.history.replaceState(null, "", "/?code=bad");
    mocks.handleRedirectCallback.mockRejectedValue("nope");
    await renderApp();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "Sign-in callback failed. Try signing in again.",
    );
  });

  it("returns to the idle actions after a failed callback", async () => {
    window.history.replaceState(null, "", "/?code=bad");
    mocks.handleRedirectCallback.mockRejectedValue(new Error("boom"));
    await renderApp();
    expect(container.textContent).not.toContain("Completing sign-in…");
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(false);
    }
  });

  it("derives a deterministic sector-scoped mock pairwise sub", async () => {
    await renderApp();
    const demoButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Demo pairwise sub"),
    );
    await act(async () => {
      demoButton?.click();
    });
    const expected = Array.from(
      new TextEncoder().encode(`${props.sector}:demo-principal`),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    expect(container.textContent).toContain(
      `Mock verified pairwise sub: pw_${expected}`,
    );
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

  it("signs out and clears session and mock sub state", async () => {
    mocks.getSession.mockResolvedValue(session({ sub: "pw_alpha" }));
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
    expect(container.textContent).not.toContain("Session pairwise sub:");
    expect(container.textContent).not.toContain("Mock verified pairwise sub:");
    expect(container.textContent).toContain("Signed out.");
  });

  it("creates the client against the loopback issuer and rp redirect URI", async () => {
    await renderApp();
    expect(mocks.createOpenSesame).toHaveBeenCalledWith({
      issuer: "http://127.0.0.1:8788",
      clientId: props.clientId,
      redirectUri: `http://127.0.0.1:${props.port}/`,
    });
  });
});
