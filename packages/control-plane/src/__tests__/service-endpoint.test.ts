import { describe, expect, it } from "vitest";
import { secureServiceEndpoint } from "../deployment-mode.js";
import { hostApiEndpoint } from "../routes/organizations.js";

describe("credential-bearing service transport", () => {
  it.each([
    "http://host.example",
    "https://user:secret@host.example",
    "https://host.example/?token=secret",
    "https://host.example/#secret",
    "ftp://host.example",
    "http://localhost.attacker.example",
  ])("refuses unsafe endpoint %s", (url) => {
    expect(() => secureServiceEndpoint(url)).toThrow();
    expect(hostApiEndpoint(url, "api/v1/device/approve")).toBeUndefined();
  });

  it.each([
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
    "http://localhost:8787",
  ])("permits plaintext only outside production at %s", (url) => {
    expect(secureServiceEndpoint(url).href).toBe(`${url}/`);
    expect(() => secureServiceEndpoint(url, true)).toThrow("requires HTTPS");
  });

  it("preserves an operator-configured HTTPS base path", () => {
    expect(
      hostApiEndpoint("https://host.example/tenant", "api/v1/device/approve")
        ?.href,
    ).toBe("https://host.example/tenant/api/v1/device/approve");
  });
});
