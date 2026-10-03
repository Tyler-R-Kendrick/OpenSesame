import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VAULT_SEALED_PANELS,
  connectFormDraws,
  connectRoadSeams,
  connectorActs,
  formRoad,
  resetConnectRoadSeams,
} from "./connect-roads.js";
import { identitySeams } from "./identity.js";
import { hasConnectRoute } from "./vercel-connect-catalog.js";
import { setVercelConnectAuth, usesConnect } from "./vercel-connect.js";

const original = { ...identitySeams };

beforeEach(() => {
  connectRoadSeams.usesConnect = usesConnect;
  connectRoadSeams.hasConnectRoute = hasConnectRoute;
});

afterEach(() => {
  Object.assign(identitySeams, original);
  resetConnectRoadSeams();
  setVercelConnectAuth(null);
});

describe("the road a form saves through", () => {
  it("seals a key or a configuration on the device", () => {
    expect(formRoad("1password", "configuration")).toBe("local");
    expect(formRoad("privacy", "api_key")).toBe("local");
    setVercelConnectAuth({ token: "t" });
    expect(formRoad("doppler", "api_key")).toBe("local");
  });

  it("is never a Host: a configured Host with a live grant opens no other road", () => {
    resetConnectRoadSeams();
    identitySeams.hostBase = () => "https://host.example";
    identitySeams.hostLocalSessionEligible = () => true;
    expect(formRoad("1password", "configuration")).toBe("local");
    expect(formRoad("doppler", "api_key")).toBe("local");
    expect(formRoad("slack", "oauth2_authorization_code")).toBeNull();
    expect(connectorActs({ id: "slack" }, false)).toBe(false);
  });

  it("has no road for an authorize-only connector until Connect holds it", () => {
    expect(formRoad("github", "oauth2_authorization_code")).toBeNull();
    expect(formRoad("slack", "oauth2_authorization_code")).toBeNull();
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
  });

  it("is not drawn for an authorize-only connector no road takes", () => {
    expect(
      connectFormDraws({ id: "slack", authKind: "oauth2_authorization_code" }),
    ).toBe(false);
    setVercelConnectAuth({ token: "t" });
    expect(
      connectFormDraws({ id: "slack", authKind: "oauth2_authorization_code" }),
    ).toBe(true);
  });
});

describe("a connector that has something to do", () => {
  it("is drawn for what the browser does alone", () => {
    for (const id of ["git", "gitlab", "github", "password-store"]) {
      expect(connectorActs({ id }, false)).toBe(true);
    }
  });

  it("hides an authorize-only connector until Connect can take it", () => {
    resetConnectRoadSeams();
    expect(connectorActs({ id: "slack" }, false)).toBe(false);
  });

  it("draws that connector once Connect holds a route for it", () => {
    resetConnectRoadSeams();
    connectRoadSeams.hasConnectRoute = (id) => id === "slack";
    expect(connectorActs({ id: "slack" }, false)).toBe(true);
  });

  it("is drawn for a key or a configuration", () => {
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
  });

  it("draws a vault-sealed panel for an unlocked vault and for nothing else", () => {
    for (const id of VAULT_SEALED_PANELS) {
      expect(connectorActs({ id }, false)).toBe(false);
      expect(connectorActs({ id }, true)).toBe(true);
    }
    // A Host does not open these while the vault is locked. YubiKey is not
    // among them: the browser does not enroll it (ADR 0152).
    identitySeams.hostBase = () => "https://host.example";
    identitySeams.hostLocalSessionEligible = () => true;
    for (const id of VAULT_SEALED_PANELS) {
      expect(connectorActs({ id }, false)).toBe(false);
    }
  });
});
