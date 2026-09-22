import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRefName,
  locatorKind,
  normalizeTransportSettings,
  readTransportSettings,
  readTransportTarget,
  transportTargetNames,
  transportTargetSettings,
  withTransportTarget,
} from "./transport-settings.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("locatorKind — a tenant form never names a locator", () => {
  it.each([
    ["/etc/ssl/certs/host.pem", "path"],
    ["./certs/leaf.crt", "path"],
    ["../keys/host.key", "path"],
    ["~/.config/opensesame/tls", "path"],
    ["C:\\certs\\host.pfx", "path"],
    ["certs/leaf.pem", "path"],
    ["/run/spire/sockets/agent.sock", "socket"],
    ["agent.sock", "socket"],
    ["unix:/tmp/agent.sock", "socket"],
    ["https://vault.example.test", "url"],
    ["spiffe://example.org/host", "url"],
    ["tcp:vault.internal:8200", "url"],
    ["nats://bus.internal:4222", "url"],
    [PEM, "pem"],
    ["-----BEGIN PRIVATE KEY-----", "pem"],
    ["private-key", "key"],
    ["secret_key", "key"],
    ["ssh-ed25519 AAAAC3", "key"],
    ["age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq", "key"],
    ["AKIAIOSFODNN7EXAMPLE", "key"],
    ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "key"],
    ["A".repeat(80), "key"],
  ])("refuses %s as %s", (value, kind) => {
    expect(locatorKind(value)).toBe(kind);
    expect(isRefName(value)).toBe(false);
  });

  it("admits a reference name", () => {
    for (const name of ["host-tls", "prod.identity", "spire_a", "a", "0x"]) {
      expect(locatorKind(name)).toBeNull();
      expect(isRefName(name)).toBe(true);
    }
    expect(isRefName("Host")).toBe(false);
    expect(isRefName("-lead")).toBe(false);
    expect(isRefName("")).toBe(false);
    expect(isRefName("a".repeat(65))).toBe(false);
  });
});

describe("readTransportTarget", () => {
  it("reads a whole block of references", () => {
    expect(
      readTransportTarget({
        desiredPolicy: "mtls_required",
        executionTarget: "host",
        identityRef: { name: "host-identity" },
        trustRef: { name: "private-root" },
        browserProfile: { kind: "browser_managed", displayName: "Work laptop" },
      }),
    ).toEqual({
      desiredPolicy: "mtls_required",
      executionTarget: "host",
      identityRef: { name: "host-identity" },
      trustRef: { name: "private-root" },
      browserProfile: { kind: "browser_managed", displayName: "Work laptop" },
    });
  });

  it.each([
    ["a path in identityRef", { identityRef: { name: "/etc/ssl/leaf.pem" } }],
    [
      "a socket in identityRef",
      { identityRef: { name: "unix:/run/agent.sock" } },
    ],
    [
      "a URL in trustRef",
      { trustRef: { name: "https://ca.example.test/root" } },
    ],
    ["a PEM in trustRef", { trustRef: { name: PEM } }],
    ["a key in identityRef", { identityRef: { name: "secret_key" } }],
    ["a ref that is a bare string", { identityRef: "host-identity" }],
    [
      "a URL as a display name",
      { browserProfile: { kind: "browser_managed", displayName: "https://x" } },
    ],
    [
      "an unknown profile kind",
      { browserProfile: { kind: "os_keychain", displayName: "x" } },
    ],
    ["an unknown policy", { desiredPolicy: "auto" }],
    ["an unknown execution target", { executionTarget: "daemon" }],
    ["a boolean policy", { desiredPolicy: true }],
  ])("refuses the whole block for %s", (_name, patch) => {
    expect(
      readTransportTarget({
        desiredPolicy: "server_tls",
        executionTarget: "browser",
        ...patch,
      }),
    ).toBeNull();
  });
});

describe("readTransportSettings", () => {
  it("drops an entry with a locator key or a malformed block, keeps the rest", () => {
    const read = readTransportSettings({
      "host-tls": { desiredPolicy: "mtls_required", executionTarget: "host" },
      "/etc/hosts": { desiredPolicy: "server_tls", executionTarget: "browser" },
      worker: {
        desiredPolicy: "server_tls",
        executionTarget: "worker",
        identityRef: { name: PEM },
      },
      nothing: "x",
    });
    expect(transportTargetNames(read)).toEqual(["host-tls"]);
  });

  it("is empty for anything that is not an object", () => {
    expect(readTransportSettings(undefined)).toEqual({});
    expect(readTransportSettings("x")).toEqual({});
    expect(readTransportSettings([])).toEqual({});
  });
});

describe("withTransportTarget", () => {
  it("writes a target, removes a target set back to defaults, ignores a bad name", () => {
    const one = withTransportTarget({}, "host-tls", {
      desiredPolicy: "mtls_required",
      executionTarget: "host",
    });
    expect(transportTargetNames(one)).toEqual(["host-tls"]);
    expect(transportTargetSettings(one, "host-tls").desiredPolicy).toBe(
      "mtls_required",
    );
    expect(transportTargetSettings(one, "other")).toEqual({
      desiredPolicy: "existing_local",
      executionTarget: "browser",
    });
    const gone = withTransportTarget(one, "host-tls", {
      desiredPolicy: "existing_local",
      executionTarget: "browser",
    });
    expect(gone).toEqual({});
    expect(
      withTransportTarget(one, "https://x", {
        desiredPolicy: "server_tls",
        executionTarget: "browser",
      }),
    ).toEqual(one);
    expect(normalizeTransportSettings(undefined)).toEqual({});
  });
});

describe("the persisted block defaults empty and never keeps a locator", () => {
  it("is empty on a fresh origin and on a loopback build alike", async () => {
    vi.stubEnv("VITE_HOST_API", "http://localhost:18787");
    const { loadTransportSettings } = await import("./transport-settings.js");
    const { loadSettings } = await import("./settings.js");
    expect(loadTransportSettings()).toEqual({});
    expect(loadSettings().hostApi).toBe("http://localhost:18787");
  });

  it("round-trips references and drops a locator whole", async () => {
    const {
      loadTransportSettings,
      saveTransportSettings,
      transportSettingsEpoch,
    } = await import("./transport-settings.js");
    const before = transportSettingsEpoch();
    saveTransportSettings({
      "host-tls": {
        desiredPolicy: "mtls_required",
        executionTarget: "host",
        identityRef: { name: "host-identity" },
      },
      leak: {
        desiredPolicy: "mtls_required",
        executionTarget: "host",
        identityRef: { name: "/etc/ssl/private/host.key" },
      },
    });
    expect(transportSettingsEpoch()).toBe(before + 1);
    expect(loadTransportSettings()).toEqual({
      "host-tls": {
        desiredPolicy: "mtls_required",
        executionTarget: "host",
        identityRef: { name: "host-identity" },
      },
    });
  });
});
