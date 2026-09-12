import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { overlapCast } from "@opensesame/os-domain";
import { defaultCapabilityConnectors } from "../../../lib/capabilities.js";
import type { Connection } from "../../../lib/connections.js";
import { connectionSeams } from "../../../lib/connections.js";
import { identitySeams } from "../../../lib/identity.js";
import type { PlaneStatus } from "../../../lib/planes.js";
import { planeSeams } from "../../../lib/planes.js";
import { settingsSeams } from "../../../lib/settings.js";
import { createSetupSeams } from "../test-seams.js";
import { ConnectorCards } from "./ConnectorCards.js";

const seams = createSetupSeams();
const originalConnectionSeams = { ...connectionSeams };
const originalPlaneSeams = { ...planeSeams };
const originalIdentitySeams = { ...identitySeams };

let capabilityConnectors = defaultCapabilityConnectors();

function planes(host: "live" | "down"): PlaneStatus {
  return { host, hostBase: "", identity: "down", identityBase: "" };
}

/** A connection as the Host would return it, populated only with the fields
 * the cards read — `overlapCast` documents the runtime overlap. */
function makeConnection(overrides: Partial<Connection>): Connection {
  return overlapCast({
    connectionId: "conn_1",
    providerId: "github",
    status: "pending",
    statusDetail: null,
    accountLabel: null,
    ...overrides,
  });
}

beforeEach(() => {
  seams.reset();
  capabilityConnectors = defaultCapabilityConnectors();
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(planeSeams, originalPlaneSeams);
  Object.assign(identitySeams, originalIdentitySeams);
  planeSeams.usePlaneStatus = () => planes("down");
  identitySeams.ensureHostSession = async () => overlapCast({});
  connectionSeams.listConnections = async () => [];
  connectionSeams.createConnection = async (body) =>
    makeConnection({ providerId: body.providerId });
  connectionSeams.authorizeConnection = async () => ({
    authorizationUrl: "https://host.example/consent",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  // The harness's settings seam records only its four fields; the capability
  // bindings these cards write are asserted here instead.
  settingsSeams.saveSettings = (next) => {
    capabilityConnectors = next.capabilityConnectors ?? capabilityConnectors;
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openConsent() {
  const tab = { location: { href: "" }, close: vi.fn(), closed: false };
  vi.stubGlobal(
    "open",
    vi.fn(() => tab),
  );
  return tab;
}

function connectOn(name: RegExp): void {
  const card = screen.getByRole("button", { name }).closest("li");
  if (!card) throw new Error("the connector card has no surrounding item");
  fireEvent.click(within(card).getByRole("button", { name: /Connect/ }));
}

describe("connector cards (ADR 0114)", () => {
  it("binds a no-account connector the moment it is chosen", () => {
    render(<ConnectorCards id="history" />);
    fireEvent.click(
      screen.getByRole("button", { name: /Local git password-store/ }),
    );
    expect(capabilityConnectors.history.providerId).toBe("password-store");
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("withholds Connect and says so where no Host answers", () => {
    render(<ConnectorCards id="history" />);
    expect(screen.getAllByText("Needs a Host").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByText(/Authorization talks to the Host/)).toBeTruthy();
  });

  it("opens the ceremony in a new tab and reports the established connection", async () => {
    planeSeams.usePlaneStatus = () => planes("live");
    const tab = openConsent();
    connectionSeams.awaitConsent = async () => ({
      result: "active",
      connection: makeConnection({ status: "active", accountLabel: "octocat" }),
    });
    render(<ConnectorCards id="history" />);
    connectOn(/GitHub/);

    await waitFor(() =>
      expect(screen.getByText(/Connected as octocat/)).toBeTruthy(),
    );
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.location.href).toBe("https://host.example/consent");
    expect(capabilityConnectors.history.providerId).toBe("github");
  });

  it("says plainly when consent is not finished, and binds nothing", async () => {
    planeSeams.usePlaneStatus = () => planes("live");
    openConsent();
    connectionSeams.awaitConsent = async () => ({ result: "abandoned" });
    render(<ConnectorCards id="history" />);
    connectOn(/GitLab/);

    await screen.findByText(/Consent was not finished/);
    expect(capabilityConnectors.history.providerId).toBe("github");
  });
});
