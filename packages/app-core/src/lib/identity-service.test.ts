import { describe, expect, it } from "vitest";
import { normalizeSignInService } from "./identity-service.js";

describe("normalizeSignInService", () => {
  it("keeps an https address without its trailing slash", () => {
    expect(normalizeSignInService(" https://login.example.com/ ")).toBe(
      "https://login.example.com",
    );
    expect(normalizeSignInService("https://example.com/identity/")).toBe(
      "https://example.com/identity",
    );
  });

  it("allows http only on this machine", () => {
    expect(normalizeSignInService("http://127.0.0.1:8788")).toBe(
      "http://127.0.0.1:8788",
    );
    expect(normalizeSignInService("http://localhost:8788/")).toBe(
      "http://localhost:8788",
    );
    expect(normalizeSignInService("http://login.example.com")).toBeNull();
  });

  it("refuses what a code may not be requested from", () => {
    for (const bad of [
      "",
      "   ",
      "login.example.com",
      "ftp://login.example.com",
      "javascript:alert(1)",
      "https://user:pass@login.example.com",
      "https://login.example.com/?next=/x",
      "https://login.example.com/#frag",
    ]) {
      expect(normalizeSignInService(bad)).toBeNull();
    }
  });
});

describe("normalizeSignInService trailing slashes", () => {
  it("strips the whole trailing run so requests are not misrouted", () => {
    expect(normalizeSignInService("https://login.example.com///")).toBe(
      "https://login.example.com",
    );
    expect(normalizeSignInService("https://example.com/identity//")).toBe(
      "https://example.com/identity",
    );
  });
});
