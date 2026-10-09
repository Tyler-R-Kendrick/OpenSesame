import { describe, expect, it } from "vitest";
import { runtimeConfig } from "./write-runtime-config.mjs";

describe("runtimeConfig", () => {
  it("refuses the retired Identity/Host/daemon and connect stamps", () => {
    expect(() =>
      runtimeConfig({
        PAGES_HOST_API: "https://host.example",
      }),
    ).toThrow(/PAGES_HOST_API/);
    expect(() =>
      runtimeConfig({
        PAGES_IDENTITY_API: "https://identity.example",
      }),
    ).toThrow(/PAGES_IDENTITY_API/);
    expect(() =>
      runtimeConfig({
        PAGES_DAEMON_API: "http://127.0.0.1:18790",
      }),
    ).toThrow(/PAGES_DAEMON_API/);
    expect(() =>
      runtimeConfig({
        PAGES_CONNECT_CALLBACK_BASE: "/",
      }),
    ).toThrow(/PAGES_CONNECT_CALLBACK_BASE/);
  });

  it("keeps only the optional non-backend stamps a deployment set", () => {
    expect(
      runtimeConfig({
        PAGES_SUPPORT_AGENT_URL: " https://support.example/agui ",
      }),
    ).toEqual({ supportAgentUrl: "https://support.example/agui" });
  });

  it("publishes the registered Linear client ID without accepting client secrets", () => {
    expect(
      runtimeConfig({
        PAGES_LINEAR_CLIENT_ID: " public-linear-client ",
        PAGES_LINEAR_CLIENT_SECRET: "must-not-ship",
      }),
    ).toEqual({ linearClientId: "public-linear-client" });
  });

  it("is empty when nothing is set", () => {
    expect(runtimeConfig({})).toEqual({});
  });
});
