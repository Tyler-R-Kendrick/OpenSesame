import { describe, expect, it } from "vitest";
import {
  classifyHost,
  classifyIdentity,
  hostStatusLabel,
  needsHostPairing,
} from "./planes.js";

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
