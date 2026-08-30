import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  classifyHost,
  classifyIdentity,
  hostStatusLabel,
  identityStatusLabel,
  needsHostPairing,
} from "./planes.js";
import { saveSettings } from "./settings.js";

describe("plane status", () => {
  it("calls a reachable Host live even on loopback", () => {
    expect(classifyHost("http://127.0.0.1:8787", "reachable")).toBe("live");
  });

  it("does not call a loopback Host down when it is simply not on this page", () => {
    expect(classifyHost("http://127.0.0.1:8787", "unreachable")).toBe(
      "loopback",
    );
    expect(hostStatusLabel("loopback")).toBe("Host not on this page");
  });

  it("keeps a configured Host pending while the first probe runs", () => {
    expect(classifyHost("https://box.tail123.ts.net/host", "unknown")).toBe(
      "pending",
    );
    expect(hostStatusLabel("pending")).toBe("Host checking");
  });

  it("calls a public Host that does not answer down", () => {
    expect(classifyHost("https://host.example", "unreachable")).toBe("down");
  });

  it("treats an empty Host as unset, not down", () => {
    expect(classifyHost("", "unknown")).toBe("unset");
    expect(hostStatusLabel("unset")).toBe("Host not configured");
  });

  it("does not treat a missing session as Identity down when the API answers", () => {
    expect(classifyIdentity(false, "reachable")).toBe("none");
    expect(classifyIdentity(true, "unreachable")).toBe("connected");
    expect(classifyIdentity(false, "unreachable")).toBe("down");
  });

  it("does not demand Connect again once Host is live or still checking", () => {
    expect(
      needsHostPairing({
        host: "live",
        hostBase: "https://box.tail123.ts.net/host",
        identity: "none",
        identityBase: "https://box.tail123.ts.net/identity",
      }),
    ).toBe(false);
    expect(
      needsHostPairing({
        host: "pending",
        hostBase: "https://box.tail123.ts.net/host",
        identity: "down",
        identityBase: "https://box.tail123.ts.net/identity",
      }),
    ).toBe(false);
    expect(
      needsHostPairing({
        host: "unset",
        hostBase: "",
        identity: "down",
        identityBase: "",
      }),
    ).toBe(true);
  });
});

describe("plane status labels and pairing guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("labels every plane state", () => {
    expect(hostStatusLabel("live")).toBe("Host live");
    expect(hostStatusLabel("down")).toBe("Host down");
    expect(identityStatusLabel("connected")).toBe("Identity connected");
    expect(identityStatusLabel("none")).toBe("No identity session");
    expect(identityStatusLabel("down")).toBe("Identity down");
  });

  it("asks for pairing only when a loopback Host is useless here", () => {
    // This runtime has no location — treated as loopback.
    expect(
      needsHostPairing({
        host: "loopback",
        hostBase: "http://127.0.0.1:8787",
        identity: "down",
        identityBase: "",
      }),
    ).toBe(false);

    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
    });
    expect(
      needsHostPairing({
        host: "loopback",
        hostBase: "http://127.0.0.1:8787",
        identity: "down",
        identityBase: "",
      }),
    ).toBe(true);
    // A down Host with a working remote pairing does not nag again.
    saveSettings({
      hostApi: "https://box.tail123.ts.net/host",
      identityApi: "https://box.tail123.ts.net/identity",
      daemonApi: "https://box.tail123.ts.net",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    expect(
      needsHostPairing({
        host: "down",
        hostBase: "https://box.tail123.ts.net/host",
        identity: "down",
        identityBase: "https://box.tail123.ts.net/identity",
      }),
    ).toBe(false);
  });
});
