/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { writeCliAppIntegrationBearer } from "./bearer-session.js";
import { fetchFirstCliAppPending } from "./client.js";

describe("cli-app-integration client", () => {
  const originalEligible = localNetworkFetchSeams.eligible;

  beforeEach(() => {
    configureHost(createTestHost());
    localNetworkFetchSeams.eligible = () => true;
  });

  afterEach(() => {
    localNetworkFetchSeams.eligible = originalEligible;
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
      const row = await fetchFirstCliAppPending("http://127.0.0.1:18790", {
        authorization: `Bearer ${"D".repeat(43)}`,
        Origin: window.location.origin,
      });
      expect(row?.verb).toBe("read");
      expect(row?.requestId).toBe("req-1");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
