import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdkBrowserSeams } from "../sdk-browser.js";
import { SignInPage } from "./SignInPage.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

interface MockClient {
  signIn: ReturnType<typeof vi.fn>;
  handleRedirectCallback: ReturnType<typeof vi.fn>;
  getReturnTo: ReturnType<typeof vi.fn>;
  continueAnonymously: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
}

let client: MockClient;
let container: HTMLDivElement;
let root: Root;

/** Where the router went, so a post-callback redirect can be asserted. */
function RouteProbe() {
  const location = useLocation();
  return <span data-testid="route">{location.pathname}</span>;
}

function routedTo(): string | undefined {
  return container.querySelector('[data-testid="route"]')?.textContent ?? "";
}

/** The browser URL the page reads its authorization response from. */
function visit(url: string): void {
  window.history.replaceState(null, "", url);
}

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SignInPage />
        <RouteProbe />
      </MemoryRouter>,
    );
  });
}

/**
 * StrictMode mounts, tears down, and remounts the same instance — the shape a
 * single-use PKCE verifier is most easily spent twice by.
 */
async function renderTwiceMounted(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter>
          <SignInPage />
          <RouteProbe />
        </MemoryRouter>
      </StrictMode>,
    );
  });
  // Belt and braces: a re-render must not restart the exchange either.
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter>
          <SignInPage />
          <RouteProbe />
        </MemoryRouter>
      </StrictMode>,
    );
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonNamed(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!button) throw new Error(`button "${text}" not rendered`);
  return button;
}

/** The catalog endpoint, answered before any component asks for it. */
function stubCatalog(providers: BoundaryValue[] | null, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      expect(String(input)).toContain("/v1/federated/providers");
      return Promise.resolve(
        new Response(
          JSON.stringify(
            providers === null ? { error: "not_found" } : { providers },
          ),
          {
            status: providers === null ? 404 : status,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }),
  );
}

/** Let the catalog fetch settle into the rendered buttons. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  // The default: a deployment that publishes no catalog, so the console keeps
  // the shoo fallback it has always had.
  stubCatalog(null);
  client = {
    signIn: vi.fn(),
    handleRedirectCallback: vi.fn(),
    getReturnTo: vi.fn(() => null),
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  };
  sdkBrowserSeams.createOpenSesame = vi.fn(() => overlapCast(client));
  sessionStorage.clear();
  visit("/");
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("SignInPage", () => {
  it("offers upstream sign-in, a provisional session, and sign-out", async () => {
    await render();
    expect(container.textContent).toContain("Sign in");
    expect(buttonNamed("Sign in with OpenSesame")).toBeDefined();
    expect(buttonNamed("Sign in with Google")).toBeDefined();
    expect(buttonNamed("Continue anonymously")).toBeDefined();
    expect(buttonNamed("Sign out")).toBeDefined();
    expect(sdkBrowserSeams.createOpenSesame).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "opensesame-console" }),
    );
  });

  it("returns to idle when upstream sign-in succeeds", async () => {
    client.signIn.mockResolvedValue(undefined);
    await render();
    await click(buttonNamed("Sign in with OpenSesame"));
    expect(client.signIn).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".err")).toBeNull();
    expect(buttonNamed("Sign in with OpenSesame").disabled).toBe(false);
  });

  it("shows the error message when upstream sign-in fails", async () => {
    client.signIn.mockRejectedValue(new Error("popup blocked"));
    await render();
    await click(buttonNamed("Sign in with OpenSesame"));
    expect(container.textContent).toContain("popup blocked");
  });

  it("falls back to a generic message for non-Error sign-in failures", async () => {
    client.signIn.mockRejectedValue("weird");
    await render();
    await click(buttonNamed("Sign in with OpenSesame"));
    expect(container.textContent).toContain(
      "Sign-in failed. Check the Identity API and try again.",
    );
  });

  it("reports an active provisional session and forgets any stashed claim", async () => {
    sessionStorage.setItem(
      "opensesame.claim",
      JSON.stringify({ token: "osc_clm_x.secret", presented: false }),
    );
    client.continueAnonymously.mockResolvedValue({ anonymous: true });
    await render();
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Provisional session active");
    expect(sessionStorage.getItem("opensesame.claim")).toBeNull();
  });

  it("names the principal when the session is not anonymous", async () => {
    client.continueAnonymously.mockResolvedValue({
      anonymous: false,
      sub: "prn_9",
    });
    await render();
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Signed in as prn_9");
  });

  it("says unknown when the session carries no principal id", async () => {
    client.continueAnonymously.mockResolvedValue({ anonymous: false });
    await render();
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Signed in as unknown");
  });

  it("shows the failure when a provisional session cannot start", async () => {
    client.continueAnonymously.mockRejectedValue(new Error("IdP down"));
    await render();
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("IdP down");
  });

  it("falls back to a generic message for non-Error provisional failures", async () => {
    client.continueAnonymously.mockRejectedValue(503);
    await render();
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain(
      "Could not start a provisional session.",
    );
  });

  it("sign-out clears the session hint, the error, and any stashed claim", async () => {
    sessionStorage.setItem(
      "opensesame.claim",
      JSON.stringify({ token: "osc_clm_x.secret", presented: false }),
    );
    client.signIn.mockRejectedValue(new Error("popup blocked"));
    client.continueAnonymously.mockResolvedValue({ anonymous: true });
    client.signOut.mockResolvedValue(undefined);
    await render();
    await click(buttonNamed("Sign in with OpenSesame"));
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Provisional session active");
    await click(buttonNamed("Sign out"));
    expect(client.signOut).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output.ok")).toBeNull();
    expect(container.querySelector(".err")).toBeNull();
    expect(sessionStorage.getItem("opensesame.claim")).toBeNull();
  });

  it("sends the Google button through the shoo broker", async () => {
    client.signIn.mockResolvedValue(undefined);
    await render();
    await click(buttonNamed("Sign in with Google"));
    expect(client.signIn).toHaveBeenCalledTimes(1);
    expect(client.signIn).toHaveBeenCalledWith({ provider: "shoo" });
  });

  it("shows the error message when broker sign-in fails", async () => {
    client.signIn.mockRejectedValue(new Error("broker unreachable"));
    await render();
    await click(buttonNamed("Sign in with Google"));
    expect(container.textContent).toContain("broker unreachable");
  });

  it("renders a button for every provider the Identity API publishes", async () => {
    stubCatalog([
      { id: "google", label: "Google", kind: "oidc", browserCapable: false },
      { id: "github", label: "GitHub", kind: "oauth2", browserCapable: false },
    ]);
    client.signIn.mockResolvedValue(undefined);
    await render();
    await settle();
    await click(buttonNamed("Sign in with GitHub"));
    expect(client.signIn).toHaveBeenCalledWith({ provider: "github" });
    // The static fallback is replaced by the published catalog, not added to.
    expect(() => buttonNamed("Sign in with Google")).not.toThrow();
  });

  it("keeps the shoo fallback when the catalog is empty", async () => {
    stubCatalog([]);
    client.signIn.mockResolvedValue(undefined);
    await render();
    await settle();
    await click(buttonNamed("Sign in with Google"));
    expect(client.signIn).toHaveBeenCalledWith({ provider: "shoo" });
  });

  it("keeps the shoo fallback when the Identity API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    client.signIn.mockResolvedValue(undefined);
    await render();
    await settle();
    await click(buttonNamed("Sign in with Google"));
    expect(client.signIn).toHaveBeenCalledWith({ provider: "shoo" });
  });

  it("does not touch the callback exchange on a plain visit", async () => {
    await render();
    expect(client.handleRedirectCallback).not.toHaveBeenCalled();
    expect(buttonNamed("Sign in with OpenSesame")).toBeDefined();
    expect(buttonNamed("Sign in with Google")).toBeDefined();
    expect(buttonNamed("Continue anonymously")).toBeDefined();
    expect(buttonNamed("Sign out")).toBeDefined();
  });

  it("completes the PKCE exchange exactly once across a double mount", async () => {
    visit("/?code=abc&state=xyz");
    client.handleRedirectCallback.mockResolvedValue({
      anonymous: false,
      sub: "prn_7",
    });
    await renderTwiceMounted();
    // The verifier is single-use: a second exchange would fail on state the
    // first one already spent.
    expect(client.handleRedirectCallback).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Signed in as prn_7");
  });

  it("shows the signed-in session hint after the redirect exchange", async () => {
    visit("/?code=abc&state=xyz");
    client.handleRedirectCallback.mockResolvedValue({
      anonymous: false,
      sub: "prn_3",
    });
    await render();
    expect(client.handleRedirectCallback).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output.ok")?.textContent).toBe(
      "Signed in as prn_3",
    );
    expect(container.querySelector(".err")).toBeNull();
  });

  it("names the session unknown when the exchange carries no principal", async () => {
    visit("/?code=abc&state=xyz");
    client.handleRedirectCallback.mockResolvedValue({ anonymous: false });
    await render();
    expect(container.textContent).toContain("Signed in as unknown");
  });

  it("honors the stored return-to after a successful exchange", async () => {
    visit("/?code=abc&state=xyz");
    client.handleRedirectCallback.mockResolvedValue({
      anonymous: false,
      sub: "prn_7",
    });
    client.getReturnTo.mockReturnValue("/task-access");
    await render();
    expect(routedTo()).toBe("/task-access");
  });

  it("stays put when no return-to was stored", async () => {
    visit("/?code=abc&state=xyz");
    client.handleRedirectCallback.mockResolvedValue({
      anonymous: false,
      sub: "prn_7",
    });
    await render();
    expect(routedTo()).toBe("/");
  });

  it("renders a refused authorization and still offers the sign-in buttons", async () => {
    visit("/?error=access_denied");
    client.handleRedirectCallback.mockRejectedValue(
      new Error("Authorization error: access_denied"),
    );
    await render();
    expect(client.handleRedirectCallback).toHaveBeenCalledTimes(1);
    const shown = container.querySelector(".err");
    expect(shown?.textContent).toContain("access_denied");
    expect(buttonNamed("Sign in with OpenSesame").disabled).toBe(false);
    expect(buttonNamed("Sign in with Google").disabled).toBe(false);
    expect(buttonNamed("Continue anonymously").disabled).toBe(false);
  });

  it("falls back to a generic message for non-Error callback failures", async () => {
    visit("/?code=abc&state=xyz");
    client.handleRedirectCallback.mockRejectedValue("boom");
    await render();
    expect(container.querySelector(".err")?.textContent).toContain(
      "Sign-in could not be completed. Try again.",
    );
  });
});
