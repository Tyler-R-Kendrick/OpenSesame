import { describe, expect, it } from "vitest";
import { runtimeConfig } from "./write-runtime-config.mjs";

const pagesBackendStamp = (plane) => `${"PAGES"}_${plane}_${"API"}`;

describe("runtimeConfig", () => {
  it("refuses the retired Identity/Host/daemon and connect stamps", () => {
    expect(() =>
      runtimeConfig({
        [pagesBackendStamp("HOST")]: "https://host.example",
      }),
    ).toThrow(/static app with no Identity\/Host\/daemon backend/);
    expect(() =>
      runtimeConfig({
        [pagesBackendStamp("IDENTITY")]: "https://identity.example",
      }),
    ).toThrow(/static app with no Identity\/Host\/daemon backend/);
    expect(() =>
      runtimeConfig({
        [pagesBackendStamp("DAEMON")]: "http://127.0.0.1:18790",
      }),
    ).toThrow(/static app with no Identity\/Host\/daemon backend/);
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

  it("is empty when nothing is set", () => {
    expect(runtimeConfig({})).toEqual({});
  });
});
