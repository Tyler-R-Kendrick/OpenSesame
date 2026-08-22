import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const session: {
  current: { principalId: string; accessToken: string } | null;
} = vi.hoisted(() => ({
  current: null,
}));
const connect = vi.hoisted(() => vi.fn());
const connectState = vi.hoisted(() => ({
  connecting: false,
  error: null,
}));
const identityFetch = vi.hoisted(() => vi.fn());
const fetchPrincipal = vi.hoisted(() => vi.fn());

import { identitySeams } from "../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  identityFetch,
  fetchPrincipal,
  identityBase: () => "http://127.0.0.1:8788",
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
  useIdentitySession: () => session.current,
});
import { useOnlineSeams } from "../lib/use-online.js";
const originalUseOnlineSeams = { ...useOnlineSeams };
Object.assign(useOnlineSeams, { useOnline: () => online.value });
import { planeNoteSeams } from "../components/PlaneNote.js";
const originalPlaneNoteSeams = { ...planeNoteSeams };
Object.assign(planeNoteSeams, { PagesCannotHostNote: () => null });

import { kvDelete } from "../lib/kv.js";
import { SitesSection } from "./SitesSection.js";

function jsonResponse(body: JsonObject, ok = true, status = 200) {
  return overlapCast({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

const clientAlpha = {
  id: "cli_alpha",
  admissionMode: "pre_registered",
  displayName: "alpha.example.com",
  redirectUris: ["https://alpha.example.com/callback"],
  sectorIdentifier: "https://alpha.example.com",
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid", "profile"],
  allowedResources: [],
  state: "active",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

function mockIdentityDefaults() {
  identityFetch.mockImplementation((path: string) => {
    if (path === "/v1/oauth/clients") {
      return Promise.resolve(jsonResponse({ clients: [clientAlpha] }));
    }
    if (path.startsWith("/v1/audit/events")) {
      return Promise.resolve(jsonResponse({ events: [] }));
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
  fetchPrincipal.mockResolvedValue({ assurance: "verified" });
}

async function showIdentityClients() {
  await userEvent.click(screen.getByRole("button", { name: /^Show$/i }));
}

describe("SitesSection", () => {
  beforeEach(() => {
    online.value = true;
    session.current = null;
    connectState.connecting = false;
    connectState.error = null;
    kvDelete("site-broker.consents.v1");
    kvDelete("site-broker.policy.v1");
    mockIdentityDefaults();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the static-site panel with the broker public by default", () => {
    render(<SitesSection />);
    expect(screen.getByRole("heading", { name: "Sites" })).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Enter the site origin")).toBeTruthy();
    expect(screen.getByText(/No site origins approved yet/)).toBeTruthy();
  });

  it("builds a snippet for a valid origin and copies it", async () => {
    render(<SitesSection />);
    const origin = screen.getByLabelText(/Site origin \(snippet\)/i);
    await userEvent.type(origin, "https://app.example.com");
    // Declarative snippet by default; explicit JS on the second tab.
    expect(
      screen.getByRole("tabpanel", { name: /Declarative snippet/i })
        .textContent,
    ).toContain("data-opensesame-signin");
    await userEvent.click(screen.getByRole("tab", { name: /Explicit JS/i }));
    expect(
      screen.getByRole("tabpanel", { name: /Explicit JS snippet/i })
        .textContent,
    ).toContain("signInAndAccept");
    await userEvent.click(screen.getByRole("button", { name: /^Copy$/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("surfaces a copy failure as an alert", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<SitesSection />);
    await userEvent.type(
      screen.getByLabelText(/Site origin \(snippet\)/i),
      "https://app.example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Copy$/i }));
    expect(
      await screen.findByText(/Could not copy — select the snippet/),
    ).toBeTruthy();
  });

  it("restricts the broker to allowed domains and back", async () => {
    render(<SitesSection />);
    const domain = screen.getByPlaceholderText(/example\.com, localhost:5173/);
    await userEvent.type(domain, "app.example.com");
    await userEvent.click(
      screen.getByRole("button", { name: /Restrict to…/i }),
    );
    expect(screen.getByText("Restricted")).toBeTruthy();
    expect(screen.getByText(/now restricted to allowed domains/)).toBeTruthy();
    expect(screen.getByText("app.example.com")).toBeTruthy();

    // Removing the last allowed domain makes the broker public again.
    const row = screen.getByText("app.example.com").closest("li");
    if (!(row instanceof HTMLLIElement)) throw new Error("rule row not found");
    const remove = row.querySelector("button[title], .btn--danger");
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error("remove button not found");
    }
    await userEvent.click(remove);
    expect(screen.getByText(/The broker is public again/)).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
  });

  it("blocks domains while public and unblocks them", async () => {
    render(<SitesSection />);
    const domain = screen.getByPlaceholderText(/example\.com, localhost:5173/);
    await userEvent.type(domain, "evil.example.com");
    await userEvent.click(screen.getByRole("button", { name: /^Block$/i }));
    expect(screen.getByText(/Blocked evil\.example\.com/)).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();

    // The blocked row's danger button removes the rule.
    const row = screen.getByText("evil.example.com").closest("li");
    if (!(row instanceof HTMLLIElement)) throw new Error("rule row not found");
    const remove = row.querySelector(".btn--danger");
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error("remove button not found");
    }
    await userEvent.click(remove);
    expect(screen.getByText(/Unblocked evil\.example\.com/)).toBeTruthy();
    expect(screen.queryByText("Blocked")).toBeNull();
  });

  it("rejects a domain entry the broker cannot parse", async () => {
    render(<SitesSection />);
    const domain = screen.getByPlaceholderText(/example\.com, localhost:5173/);
    await userEvent.type(domain, "https://example.com/path");
    const { fireEvent } = await import("@testing-library/react");
    const form = domain.closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("form not found");
    fireEvent.submit(form);
    expect(
      await screen.findByText(/Enter a hostname \(example\.com\)/),
    ).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
  });

  it("remembers and revokes broker consent for the typed origin", async () => {
    render(<SitesSection />);
    await userEvent.type(
      screen.getByLabelText(/Site origin \(snippet\)/i),
      "https://app.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Remember consent/i }),
    );
    expect(
      screen.getByText(/Remembered consent for https:\/\/app\.example\.com/),
    ).toBeTruthy();
    expect(screen.getByText("Remembered consents")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Revoke/i }));
    expect(screen.getByText(/Revoked broker consent/)).toBeTruthy();
    expect(screen.getByText(/No site origins approved yet/)).toBeTruthy();
  });

  it("offers to connect identity when the clients area is shown signed-out", async () => {
    connect.mockResolvedValue(undefined);
    render(<SitesSection />);
    await showIdentityClients();
    expect(
      screen.getByText(/Connect Identity to manage registered clients/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Connect a provisional session/i }),
    );
    expect(connect).toHaveBeenCalled();
  });

  it("loads clients and shows them with their metadata", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    expect(
      await screen.findByRole("heading", { name: "alpha.example.com" }),
    ).toBeTruthy();
    expect(screen.getByText("cli_alpha")).toBeTruthy();
    expect(screen.getByText("https://alpha.example.com/callback")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("shows the empty clients state", async () => {
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    expect(await screen.findByText("No clients registered")).toBeTruthy();
  });

  it("surfaces client list failures with a retry", async () => {
    identityFetch.mockRejectedValue(new Error("socket closed"));
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    expect(
      (await screen.findAllByText(/Can't reach the Identity API/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Try again/i })).toBeTruthy();
  });

  it("registers a new client from a valid origin", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });

    const origin = screen.getByLabelText(/^Site origin$/i);
    await userEvent.type(origin, "https://beta.example.com");
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            ...clientAlpha,
            id: "cli_beta",
            displayName: "beta.example.com",
            redirectUris: ["https://beta.example.com/callback"],
          }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [clientAlpha] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(await screen.findByText(/is registered as cli_beta/)).toBeTruthy();
  });

  it("validates the origin before registering", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    const origin = screen.getByLabelText(/^Site origin$/i);
    await userEvent.type(origin, "example.com");
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      (await screen.findAllByText(/Include the scheme/)).length,
    ).toBeGreaterThan(0);
    expect(
      identityFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("rejects http origins off the loopback", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "http://app.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      (await screen.findAllByText(/only allowed for localhost/)).length,
    ).toBeGreaterThan(0);
  });

  it("blocks registration when assurance is too low", async () => {
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({ error: "assurance_too_low" }, false, 403),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    fetchPrincipal.mockResolvedValue({ assurance: "provisional" });
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    expect(await screen.findByText(/This session is provisional/)).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      await screen.findByText(/cannot register one\. Verify your identity/),
    ).toBeTruthy();
  });

  it("rotates a client after confirmation", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.click(screen.getByRole("button", { name: /^Rotate$/i }));
    expect(screen.getByText(/Rotating issues a new client id/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    // Confirm for real.
    await userEvent.click(screen.getByRole("button", { name: /^Rotate$/i }));
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith("/rotate")) {
        return Promise.resolve(
          jsonResponse({ ...clientAlpha, id: "cli_alpha_2" }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [clientAlpha] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Rotate and revoke old id/i }),
    );
    expect(
      await screen.findByText(/now uses client id cli_alpha_2/),
    ).toBeTruthy();
  });

  it("revokes a client after confirmation", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.click(screen.getByRole("button", { name: /^Revoke$/i }));
    expect(screen.getByText(/Revoking ends sign-in/)).toBeTruthy();
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith("/revoke")) {
        return Promise.resolve(
          jsonResponse({ ...clientAlpha, state: "revoked" }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Revoke this client/i }),
    );
    expect(await screen.findByText(/is revoked/)).toBeTruthy();
  });

  it("pins a client into the integration snippet", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.click(
      screen.getByRole("button", { name: /Use in snippet/i }),
    );
    const panel = screen.getByRole("tabpanel", { name: /Sign-in module/i });
    expect(panel.textContent).toContain("cli_alpha");
    expect(panel.textContent).toContain("https://alpha.example.com/callback");
    // Callback tab shows the exchange snippet.
    await userEvent.click(screen.getByRole("tab", { name: /Callback page/i }));
    expect(
      screen.getByRole("tabpanel", { name: /Callback page/i }).textContent,
    ).toContain("handleRedirectCallback");
  });

  it("marks a snippet for an unregistered origin", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://newsite.example.com",
    );
    expect(await screen.findByText(/is not registered yet/)).toBeTruthy();
    const panel = screen.getByRole("tabpanel", { name: /Sign-in module/i });
    expect(panel.textContent).toContain("REPLACE_WITH_CLIENT_ID");
  });

  it("shows client sign-in activity and labels unknown clients", async () => {
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [clientAlpha] }));
      }
      if (path.startsWith("/v1/audit/events")) {
        return Promise.resolve(
          jsonResponse({
            events: [
              {
                id: "evt_1",
                occurredAt: "2026-08-10T10:00:00Z",
                eventType: "oauth_client.registered",
                outcome: "succeeded",
                clientId: "cli_alpha",
              },
              {
                id: "evt_2",
                occurredAt: "2026-08-10T11:00:00Z",
                eventType: "oauth_client.rotated",
                outcome: "failed",
                clientId: "cli_gone",
              },
              {
                id: "evt_3",
                occurredAt: "2026-08-10T12:00:00Z",
                eventType: "session.created",
                outcome: "succeeded",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, false, 404));
    });
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    expect(await screen.findByText("oauth_client.registered")).toBeTruthy();
    expect(screen.getByText("oauth_client.rotated")).toBeTruthy();
    // Non-client events are filtered out of the table.
    expect(screen.queryByText("session.created")).toBeNull();
    expect(screen.getByText("Revoked or unknown client")).toBeTruthy();
  });

  it("shows the empty activity state", async () => {
    session.current = { principalId: "prn", accessToken: "tok" };
    render(<SitesSection />);
    await showIdentityClients();
    expect(await screen.findByText("No client activity yet")).toBeTruthy();
  });
});

describe("SitesSection origin validation and edge branches", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn", accessToken: "tok" };
    connectState.connecting = false;
    connectState.error = null;
    kvDelete("site-broker.consents.v1");
    kvDelete("site-broker.policy.v1");
    mockIdentityDefaults();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function submitOrigin(origin: string) {
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.type(screen.getByLabelText(/^Site origin$/i), origin);
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
  }

  it("rejects origins with credentials, paths, queries, and fragments", async () => {
    await submitOrigin("https://user:pass@app.example.com");
    expect(
      (await screen.findAllByText(/Remove the credentials/)).length,
    ).toBeGreaterThan(0);
    cleanup();

    await submitOrigin("https://app.example.com/app");
    expect(
      (await screen.findAllByText(/An origin has no path/)).length,
    ).toBeGreaterThan(0);
    cleanup();

    await submitOrigin("https://app.example.com/?x=1");
    expect(
      (await screen.findAllByText(/no query string/)).length,
    ).toBeGreaterThan(0);
    cleanup();

    await submitOrigin("https://app.example.com/#frag");
    expect((await screen.findAllByText(/no fragment/)).length).toBeGreaterThan(
      0,
    );
  });

  it("rejects default ports and unparseable input", async () => {
    await submitOrigin("https://app.example.com:443");
    expect(
      (await screen.findAllByText(/Drop the default port :443/)).length,
    ).toBeGreaterThan(0);
    cleanup();

    await submitOrigin("http://localhost:80");
    expect(
      (await screen.findAllByText(/Drop the default port :80/)).length,
    ).toBeGreaterThan(0);
    cleanup();

    await submitOrigin("https://");
    expect(
      (await screen.findAllByText(/Include the scheme|not a URL/)).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a loopback http origin", async () => {
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            ...clientAlpha,
            id: "cli_local",
            displayName: "localhost:5173",
            redirectUris: ["http://localhost:5173/callback"],
          }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByText("No clients registered");
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "http://localhost:5173",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(await screen.findByText(/is registered as cli_local/)).toBeTruthy();
  });

  it("shows field-level errors returned by the API", async () => {
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              error: "invalid_client_metadata",
              details: {
                fieldErrors: { redirectUris: ["not an https URI"] },
                formErrors: ["review the form"],
              },
            },
            false,
            400,
          ),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByText("No clients registered");
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      await screen.findByText(/redirectUris: not an https URI/),
    ).toBeTruthy();
    expect(screen.getByText(/review the form/)).toBeTruthy();
  });

  it("requires a display name when the default is cleared", async () => {
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    const name = document.querySelector('input[id$="-name"]');
    if (!(name instanceof HTMLInputElement)) throw new Error("name not found");
    await userEvent.clear(name);
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      await screen.findByText(/Give the site a display name/),
    ).toBeTruthy();
  });

  it("requires a sector identifier when cleared", async () => {
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    const sector = document.querySelector('input[id$="-sector"]');
    if (!(sector instanceof HTMLInputElement)) {
      throw new Error("sector not found");
    }
    await userEvent.clear(sector);
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      await screen.findByText(/sector identifier cannot be empty/i),
    ).toBeTruthy();
  });

  it("explains a lost session on load (401)", async () => {
    identityFetch.mockResolvedValue(jsonResponse({ error: "x" }, false, 401));
    render(<SitesSection />);
    await showIdentityClients();
    expect(
      (await screen.findAllByText(/no longer accepted by the Identity plane/))
        .length,
    ).toBeGreaterThan(0);
  });

  it("moves blocked domains to allowed while restricted", async () => {
    render(<SitesSection />);
    const domain = screen.getByPlaceholderText(/example\.com, localhost:5173/);
    // Restrict first, then block a second domain and move it to allowed.
    await userEvent.type(domain, "good.example.com");
    await userEvent.click(
      screen.getByRole("button", { name: /Restrict to…/i }),
    );
    await screen.findByText("Restricted");
    await userEvent.type(domain, "evil.example.com");
    await userEvent.click(screen.getByRole("button", { name: /^Block$/i }));
    await screen.findByText(/Blocked evil\.example\.com/);
    await userEvent.click(
      screen.getByRole("button", { name: /Move to allowed/i }),
    );
    // The domain moved lists.
    const allowed = overlapCast(screen.getByText("Allowed").closest("div"));
    expect(allowed.textContent).toContain("evil.example.com");
  });

  it("moves an allowed domain to blocked", async () => {
    render(<SitesSection />);
    const domain = screen.getByPlaceholderText(/example\.com, localhost:5173/);
    await userEvent.type(domain, "app.example.com");
    await userEvent.click(
      screen.getByRole("button", { name: /Restrict to…/i }),
    );
    await screen.findByText("Restricted");
    await userEvent.click(
      screen.getByRole("button", { name: /Move to blocked/i }),
    );
    const blocked = overlapCast(screen.getByText("Blocked").closest("div"));
    expect(blocked.textContent).toContain("app.example.com");
  });

  it("allows the typed origin from the toolbar", async () => {
    render(<SitesSection />);
    await userEvent.type(
      screen.getByLabelText(/Site origin \(snippet\)/i),
      "https://app.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Restrict broker to this origin/i }),
    );
    expect(
      await screen.findByText(/Allowed https:\/\/app\.example\.com/),
    ).toBeTruthy();
    expect(screen.getByText("Restricted")).toBeTruthy();
  });

  it("switches the snippet panel to a draft origin while typing", async () => {
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    // Register panel shares the origin input; typing a new origin offers the
    // draft option in the snippet selector.
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://draft.example.com",
    );
    const select = screen.getByLabelText(/Snippet for/i);
    expect(select.textContent).toContain("draft.example.com — not registered");
    await userEvent.selectOptions(select, "cli_alpha");
    const panel = screen.getByRole("tabpanel", { name: /Sign-in module/i });
    expect(panel.textContent).toContain("cli_alpha");
  });

  it("reports clipboard refusal in the integration snippet", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<SitesSection />);
    await showIdentityClients();
    await screen.findByRole("heading", { name: "alpha.example.com" });
    await userEvent.click(
      screen.getByRole("button", { name: /Use in snippet/i }),
    );
    const toolbar = screen
      .getByRole("tabpanel", { name: /Sign-in module/i })
      .closest(".panel");
    if (!(toolbar instanceof HTMLElement)) throw new Error("panel not found");
    const button = Array.from(toolbar.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Copy",
    );
    if (!button) throw new Error("copy button not found");
    await userEvent.click(button);
    expect(
      await screen.findByText(/browser refused clipboard access/),
    ).toBeTruthy();
  });
});
