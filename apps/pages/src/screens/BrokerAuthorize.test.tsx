import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fed = vi.hoisted(() => ({
  beginSignIn: vi.fn(),
  clearSession: vi.fn(),
  loadSession: vi.fn(),
}));

import { federationSeams } from "../lib/federation.js";
const originalFederationSeams = { ...federationSeams };
Object.assign(federationSeams, {
  defaultUpstream: () => ({ displayName: "MockHub", accountKind: "GitHub" }),
  displayName: () => "Alice",
  beginSignIn: fed.beginSignIn,
  clearSession: fed.clearSession,
  loadSession: fed.loadSession,
});
import { siteBrokerSeams } from "../lib/site-broker.js";
const originalSiteBrokerSeams = { ...siteBrokerSeams };
Object.assign(siteBrokerSeams, {
  deliverToRp: vi.fn(originalSiteBrokerSeams.deliverToRp),
});

import { FederationError } from "../lib/federation.js";
import { kvDelete } from "../lib/kv.js";
import { scopedKey } from "../lib/projects.js";
import {
  CONSENTS_KEY,
  POLICY_KEY,
  addDomainRule,
  approveConsent,
  consentFor,
  deliverToRp,
} from "../lib/site-broker.js";
import { BrokerAuthorize } from "./BrokerAuthorize.js";

const mockedDeliver = vi.mocked(siteBrokerSeams.deliverToRp);

const ORIGIN = "https://rp.example.com";
const STATE = "state-with-plenty-of-entropy-123456";

const IDENTITY = {
  issuer: "https://idp.example",
  upstreamId: "up_1",
  idToken: "id.token.here",
  pairwiseSub: "sub_1",
  audience: "aud_1",
  jwksUri: "https://idp.example/jwks.json",
  expiresAt: Date.now() + 3_600_000,
  name: "Alice",
};

function renderBroker(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/broker/authorize${search}`]}>
      <BrokerAuthorize />
    </MemoryRouter>,
  );
}

function validSearch(scope = "openid profile"): string {
  const params = new URLSearchParams({
    client_id: `origin:${ORIGIN}`,
    origin: ORIGIN,
    state: STATE,
    scope,
  });
  return `?${params.toString()}`;
}

describe("BrokerAuthorize", () => {
  beforeEach(() => {
    kvDelete(scopedKey(CONSENTS_KEY));
    kvDelete(scopedKey(POLICY_KEY));
    fed.beginSignIn.mockReset();
    fed.clearSession.mockReset();
    fed.loadSession.mockReset();
    mockedDeliver.mockReset();
    mockedDeliver.mockReturnValue("none");
  });

  afterEach(cleanup);

  it("rejects requests missing the required parameters", async () => {
    renderBroker("?client_id=origin:x");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Invalid request");
    expect(alert.textContent).toContain("invalid_request");
    expect(alert.textContent).toContain(
      "client_id, origin, and state are required.",
    );
  });

  it("rejects a client_id that does not match the origin", async () => {
    const params = new URLSearchParams({
      client_id: "origin:https://other.example.com",
      origin: ORIGIN,
      state: STATE,
    });
    renderBroker(`?${params.toString()}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("origin_mismatch");
  });

  it("blocks origins denied by the domain policy and informs the site", async () => {
    addDomainRule("rp.example.com", "blacklist");
    renderBroker(validSearch());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Domain not allowed");
    expect(alert.textContent).toContain("matches a blocked domain");
    expect(mockedDeliver).toHaveBeenCalledTimes(1);
    const [message, targetOrigin] = mockedDeliver.mock.calls[0] ?? [];
    expect(message).toMatchObject({
      type: "opensesame:signin",
      error: "registration_required",
      state: STATE,
    });
    expect(targetOrigin).toBe(ORIGIN);
  });

  it("asks for sign-in when there is no federation session", async () => {
    fed.loadSession.mockReturnValue(null);
    renderBroker(validSearch());
    expect(await screen.findByText("Sign in first")).toBeTruthy();
    expect(screen.getByText(ORIGIN)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeTruthy();
  });

  it("begins upstream sign-in, adding the openid scope when absent", async () => {
    fed.loadSession.mockReturnValue(null);
    fed.beginSignIn.mockReturnValue(new Promise(() => {}));
    renderBroker(validSearch("profile"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    );
    await screen.findByText("Redirecting to sign-in…");
    expect(fed.beginSignIn).toHaveBeenCalledTimes(1);
    const [upstream, options] = fed.beginSignIn.mock.calls[0] ?? [];
    expect(upstream).toEqual({ displayName: "MockHub", accountKind: "GitHub" });
    expect(options.scope).toBe("openid profile");
    expect(options.returnTo).toContain("/broker/authorize?");
    expect(options.returnTo).toContain(encodeURIComponent(ORIGIN));
  });

  it("reports a failed upstream redirect", async () => {
    fed.loadSession.mockReturnValue(null);
    fed.beginSignIn.mockRejectedValue(
      new FederationError("discovery_failed", "Could not reach the IdP."),
    );
    renderBroker(validSearch());
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Something went wrong");
    expect(alert.textContent).toContain("Could not reach the IdP.");
  });

  it("shows the consent card for a new origin and releases on approval", async () => {
    fed.loadSession.mockReturnValue(IDENTITY);
    mockedDeliver.mockReturnValue("postMessage");
    renderBroker(validSearch());

    expect(await screen.findByText("Allow this site?")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText(ORIGIN)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Allow once and remember" }),
    );
    expect(
      await screen.findByText("Sent to the site. You can close this window."),
    ).toBeTruthy();

    // The consent is remembered and the assertion went only to the RP origin.
    expect(consentFor(ORIGIN)).not.toBeNull();
    const [message, targetOrigin] = mockedDeliver.mock.calls[0] ?? [];
    expect(message).toMatchObject({
      type: "opensesame:signin",
      state: STATE,
      id_token: "id.token.here",
    });
    expect(targetOrigin).toBe(ORIGIN);
  });

  it("denies the origin and tells the user the window can close", async () => {
    fed.loadSession.mockReturnValue(IDENTITY);
    renderBroker(validSearch());
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(
      await screen.findByText("Denied. You can close this window."),
    ).toBeTruthy();
    const [message] = mockedDeliver.mock.calls[0] ?? [];
    expect(message).toMatchObject({
      type: "opensesame:signin",
      error: "consent_denied",
      state: STATE,
    });
    expect(consentFor(ORIGIN)).toBeNull();
  });

  it("lets the user switch accounts from the consent card", async () => {
    fed.loadSession.mockReturnValue(IDENTITY);
    renderBroker(validSearch());
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different account" }),
    );
    expect(fed.clearSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Sign in first")).toBeTruthy();
  });

  it("auto-releases without a consent prompt when a covering consent exists", async () => {
    approveConsent(ORIGIN, "openid profile");
    fed.loadSession.mockReturnValue(IDENTITY);
    mockedDeliver.mockReturnValue("fragment");
    renderBroker(validSearch());
    expect(
      await screen.findByText("Redirecting back to the site…"),
    ).toBeTruthy();
    expect(screen.queryByText("Allow this site?")).toBeNull();
  });

  it("says so when the site window is unreachable", async () => {
    fed.loadSession.mockReturnValue(IDENTITY);
    mockedDeliver.mockReturnValue("none");
    renderBroker(validSearch());
    fireEvent.click(
      await screen.findByRole("button", { name: "Allow once and remember" }),
    );
    expect(
      await screen.findByText(/Could not reach the site window/),
    ).toBeTruthy();
  });

  it("releases only once even if the phase re-renders", async () => {
    approveConsent(ORIGIN, "openid profile");
    fed.loadSession.mockReturnValue(IDENTITY);
    mockedDeliver.mockReturnValue("postMessage");
    renderBroker(validSearch());
    await screen.findByText("Sent to the site. You can close this window.");
    await waitFor(() => expect(mockedDeliver).toHaveBeenCalledTimes(1));
  });
});
