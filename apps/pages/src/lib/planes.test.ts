import { describe, expect, it } from "vitest";
import { classifyHost, classifyIdentity, hostStatusLabel } from "./planes.js";

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

  it("calls a public Host that does not answer down", () => {
    expect(classifyHost("https://host.example", "unreachable")).toBe("down");
  });

  it("does not treat a missing session as Identity down when the API answers", () => {
    expect(classifyIdentity(false, "reachable")).toBe("none");
    expect(classifyIdentity(true, "unreachable")).toBe("connected");
    expect(classifyIdentity(false, "unreachable")).toBe("down");
  });
});
