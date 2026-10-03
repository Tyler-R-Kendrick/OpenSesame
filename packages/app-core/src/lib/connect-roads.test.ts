import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VAULT_SEALED_PANELS,
  connectFormDraws,
  connectRoadSeams,
  connectorActs,
  formRoad,
  hostRoadOpen,
  resetConnectRoadSeams,
} from "./connect-roads.js";
import { HOST_CONNECTIONS_WRITE, hostGrantSeams } from "./host-grant.js";
import { identitySeams } from "./identity.js";
import { hasConnectRoute } from "./vercel-connect-catalog.js";
import { setVercelConnectAuth, usesConnect } from "./vercel-connect.js";

const original = { ...identitySeams };
const originalGrant = { ...hostGrantSeams };
const host = { base: "", live: false, capabilities: new Array<string>() };

/** A live approved grant that can create connections and write credentials. */
function approveConnectionsWrite() {
  host.live = true;
  host.capabilities = [HOST_CONNECTIONS_WRITE];
}

beforeEach(() => {
  host.base = "";
  host.live = false;
  host.capabilities = [];
  identitySeams.hostBase = () => host.base;
  identitySeams.hostLocalSessionEligible = () => host.live;
  hostGrantSeams.capabilities = () => host.capabilities;
  connectRoadSeams.usesConnect = usesConnect;
  connectRoadSeams.hasConnectRoute = hasConnectRoute;
});

afterEach(() => {
  Object.assign(identitySeams, original);
  Object.assign(hostGrantSeams, originalGrant);
  resetConnectRoadSeams();
  setVercelConnectAuth(null);
});

describe("the Host road", () => {
  it("is closed on the static deployment: no Host, no grant", () => {
    expect(hostRoadOpen()).toBe(false);
  });

  it("stays closed with a Host named but no approved grant to it", () => {
    host.base = "https://host.example";
    expect(hostRoadOpen()).toBe(false);
  });

  it("opens only with a named Host and a live grant that writes connections", () => {
    host.base = "https://host.example";
    approveConnectionsWrite();
    expect(hostRoadOpen()).toBe(true);
  });

  it("stays closed for a live grant that only joins or syncs", () => {
    host.base = "https://host.example";
    approveConnectionsWrite();
    host.capabilities = ["host.join"];
    expect(hostRoadOpen()).toBe(false);
    host.capabilities = ["host.sync.read", "host.sync.write"];
    expect(hostRoadOpen()).toBe(false);
    host.capabilities = ["host.connections.read"];
    expect(hostRoadOpen()).toBe(false);
  });

  it("stays closed with the capability but no live grant", () => {
    host.base = "https://host.example";
    host.capabilities = [HOST_CONNECTIONS_WRITE];
    expect(hostRoadOpen()).toBe(false);
  });

  it("closes again when the grant is withdrawn", () => {
    host.base = "https://host.example";
    approveConnectionsWrite();
    expect(hostRoadOpen()).toBe(true);
    host.capabilities = [];
    expect(hostRoadOpen()).toBe(false);
  });
});

describe("the road a form saves through", () => {
  it("seals a key or a configuration on the device when no Host is open", () => {
    expect(formRoad("1password", "configuration")).toBe("local");
    expect(formRoad("privacy", "api_key")).toBe("local");
    expect(formRoad("github", "oauth2_authorization_code")).toBeNull();
  });

  it("seals a key or a configuration through the Host when that road is open", () => {
    setVercelConnectAuth({ token: "t" });
    expect(formRoad("doppler", "api_key")).toBe("local");
    host.base = "https://host.example";
    approveConnectionsWrite();
    expect(formRoad("doppler", "api_key")).toBe("host");
    expect(formRoad("1password", "configuration")).toBe("host");
  });

  it("authorizes through Connect when it holds the provider", () => {
    setVercelConnectAuth({ token: "t" });
    expect(formRoad("slack", "oauth2_authorization_code")).toBe("connect");
    // GitHub keeps its own App road; Connect never owns it.
    expect(formRoad("github", "oauth2_authorization_code")).toBeNull();
  });
});

describe("the form a connector page draws", () => {
  it("is drawn for a remote and GitHub's App with no service at all", () => {
    expect(connectFormDraws({ id: "git", authKind: "configuration" })).toBe(
      true,
    );
    expect(
      connectFormDraws({ id: "github", authKind: "oauth2_authorization_code" }),
    ).toBe(true);
  });

  it("is drawn for a key or a configuration the device can seal", () => {
    expect(
      connectFormDraws({ id: "1password", authKind: "configuration" }),
    ).toBe(true);
    expect(connectFormDraws({ id: "lithic", authKind: "api_key" })).toBe(true);
    host.base = "https://host.example";
    approveConnectionsWrite();
    expect(
      connectFormDraws({ id: "1password", authKind: "configuration" }),
    ).toBe(true);
  });
});

describe("a connector that has something to do", () => {
  it("is drawn for what the browser does alone", () => {
    for (const id of ["git", "gitlab", "github", "password-store"]) {
      expect(connectorActs({ id }, false)).toBe(true);
    }
  });

  it("hides an authorize-only connector until Connect or a Host can take it", () => {
    resetConnectRoadSeams();
    expect(connectorActs({ id: "slack" }, false)).toBe(false);
  });

  it("hides an authorize-only connector from a join or sync grant", () => {
    resetConnectRoadSeams();
    host.base = "https://host.example";
    host.live = true;
    host.capabilities = ["host.join"];
    expect(connectorActs({ id: "slack" }, false)).toBe(false);
    approveConnectionsWrite();
    expect(connectorActs({ id: "slack" }, false)).toBe(true);
  });

  it("draws that connector once Connect holds a route for it", () => {
    resetConnectRoadSeams();
    connectRoadSeams.hasConnectRoute = (id) => id === "slack";
    expect(connectorActs({ id: "slack" }, false)).toBe(true);
  });

  it("is drawn for a key or a configuration with no Host open", () => {
    resetConnectRoadSeams();
    for (const id of [
      "better-auth",
      "workos",
      "auth0",
      "1password",
      "vault",
      "tailscale",
    ]) {
      expect(connectorActs({ id }, false)).toBe(true);
    }
    host.base = "https://host.example";
    approveConnectionsWrite();
    expect(connectorActs({ id: "better-auth" }, false)).toBe(true);
  });

  it("draws a vault-sealed panel for an unlocked vault and for nothing else", () => {
    for (const id of VAULT_SEALED_PANELS) {
      expect(connectorActs({ id }, false)).toBe(false);
      expect(connectorActs({ id }, true)).toBe(true);
    }
    // A live Host does not open these while the vault is locked. YubiKey is
    // not among them: the browser does not enroll it (ADR 0152).
    host.base = "https://host.example";
    approveConnectionsWrite();
    for (const id of VAULT_SEALED_PANELS) {
      expect(connectorActs({ id }, false)).toBe(false);
    }
  });
});
