/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { loadSettings, saveSettings } from "../settings.js";
import {
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "./bearer-session.js";
import { fetchFirstCliAppPending, readCliAppAuthHeaders } from "./client.js";

describe("cli-app-integration client", () => {
  const originalEligible = localNetworkFetchSeams.eligible;

  beforeEach(() => {
    configureHost(createTestHost());
    localNetworkFetchSeams.eligible = () => true;
    clearCliAppIntegrationBearer();
    saveSettings({ ...loadSettings(), daemonApi: "http://127.0.0.1:18790" });
  });

  afterEach(() => {
    localNetworkFetchSeams.eligible = originalEligible;
    clearCliAppIntegrationBearer();
  });

  it("returns auth headers when a bearer is stored", () => {
    const token = "C".repeat(43);
    writeCliAppIntegrationBearer(token);
    const headers = readCliAppAuthHeaders(window.location.origin);
    expect(headers?.authorization).toBe(`Bearer ${token}`);
    expect(headers?.Origin).toBe(window.location.origin);
  });

  it("reads the first pending row", async () => {
    writeCliAppIntegrationBearer("D".repeat(43));
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          pending: [
            {
              requestId: "req-1",
              terminalSessionId: "term-a",
              verb: "read",
              respondNonce: "nonce-1",
            },
          ],
        }),
        { status: 200 },
      );
    try {
      const row = await fetchFirstCliAppPending(window.location.origin);
      expect(row?.verb).toBe("read");
      expect(row?.requestId).toBe("req-1");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
