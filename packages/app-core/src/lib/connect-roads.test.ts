import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VAULT_SEALED_PANELS,
  connectFormDraws,
  connectorActs,
  formRoad,
  hostRoadOpen,
} from "./connect-roads.js";
import { identitySeams } from "./identity.js";
import { setVercelConnectAuth } from "./vercel-connect.js";

const original = { ...identitySeams };
const host = { base: "", live: false };

beforeEach(() => {
  host.base = "";
  host.live = false;
  identitySeams.hostBase = () => host.base;
  identitySeams.hostLocalSessionEligible = () => host.live;
});

afterEach(() => {
  Object.assign(identitySeams, original);
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

  it("opens only with a named Host and a live grant", () => {
    host.base = "https://host.example";
    host.live = true;
    expect(hostRoadOpen()).toBe(true);
  });
});

describe("the road a form saves through", () => {
  it("has none on a device with no Host and no Connect credential", () => {
    expect(formRoad("1password", "configuration")).toBeNull();
    expect(formRoad("privacy", "api_key")).toBeNull();
    expect(formRoad("github", "oauth2_authorization_code")).toBeNull();
  });

  it("seals a key or a configuration through the Host only", () => {
    setVercelConnectAuth({ token: "t" });
    expect(formRoad("doppler", "api_key")).toBeNull();
    host.base = "https://host.example";
    host.live = true;
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

  it("is not drawn for a key or a configuration nothing can seal", () => {
    expect(
      connectFormDraws({ id: "1password", authKind: "configuration" }),
    ).toBe(false);
    expect(connectFormDraws({ id: "lithic", authKind: "api_key" })).toBe(false);
    host.base = "https://host.example";
    host.live = true;
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

  it("is drawn for Connect's own panels, which seal the credential first", () => {
    expect(connectorActs({ id: "workos" }, false)).toBe(true);
    expect(connectorActs({ id: "auth0" }, false)).toBe(true);
  });

  it("is not drawn when the Host is the only road and it is closed", () => {
    for (const id of ["better-auth", "1password", "vault", "tailscale"]) {
      expect(connectorActs({ id }, true)).toBe(false);
    }
    host.base = "https://host.example";
    host.live = true;
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
    host.live = true;
    for (const id of VAULT_SEALED_PANELS) {
      expect(connectorActs({ id }, false)).toBe(false);
    }
  });
});
