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
import gate from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};
import { fetchFirstCliAppPending, readCliAppAuthHeaders } from "./client.js";
import { cliAppIntegrationPolicy } from "./policy-runtime.js";

describe("cli-app-integration client", () => {
  it("policy-runtime stays aligned with the conformance document slice", () => {
    expect(cliAppIntegrationPolicy.pollIntervalMs).toBe(gate.pollIntervalMs);
    expect(cliAppIntegrationPolicy.messages.pending).toBe(
      gate.messages.pending,
    );
    expect(cliAppIntegrationPolicy.ui.sheetTitle).toBe(gate.ui.sheetTitle);
    expect(cliAppIntegrationPolicy.ui.allowKey).toBe(gate.ui.allowKey);
    expect(cliAppIntegrationPolicy.daemonPaths.pending).toBe(
      gate.daemonPaths.pending,
    );
  });

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
    const headers = readCliAppAuthHeaders();
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
      const row = await fetchFirstCliAppPending();
      expect(row?.verb).toBe("read");
      expect(row?.requestId).toBe("req-1");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
