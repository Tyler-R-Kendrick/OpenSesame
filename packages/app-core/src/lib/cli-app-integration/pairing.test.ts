import { afterEach, beforeEach, describe, expect, it } from "vitest";
/** @vitest-environment jsdom */
import pairingSpec from "../../../../../spec/conformance/cli-app-integration-pairing.json" with {
  type: "json",
};
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { loadSettings, saveSettings } from "../settings.js";
import { readCliAppIntegrationBearer } from "./bearer-session.js";
import {
  CLI_APP_PAIRING_PREFIX,
  clearCliAppIntegrationBearer,
  exchangeCliAppPairingCode,
  parseCliAppPairingCode,
} from "./pairing.js";

describe("cli-app-integration pairing", () => {
  beforeEach(() => {
    configureHost(createTestHost());
    clearCliAppIntegrationBearer();
  });

  afterEach(() => {
    clearCliAppIntegrationBearer();
    saveSettings({ ...loadSettings(), daemonApi: "" });
  });

  it("parses the conformance local example", () => {
    const parsed = parseCliAppPairingCode(pairingSpec.localExample.text);
    expect(parsed).not.toBeNull();
    expect(parsed?.label).toBe("Desk");
    expect(parsed?.origin).toBe("http://localhost:5180");
    expect(parsed?.url).toBe("http://127.0.0.1:18790");
  });

  it("refuses codes without the prefix", () => {
    expect(parseCliAppPairingCode("opensesame-plugins:v1:abc")).toBeNull();
  });

  it("exchanges a code for a bearer and records the daemon address", async () => {
    const parsed = parseCliAppPairingCode(pairingSpec.localExample.text);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const token = "A".repeat(43);
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe(`${parsed.url}${pairingSpec.exchangePath}`);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ token }), { status: 201 });
    };
    try {
      const ok = await exchangeCliAppPairingCode(parsed);
      expect(ok).toBe(true);
      expect(readCliAppIntegrationBearer()).toBe(token);
      expect(loadSettings().daemonApi).toBe("http://127.0.0.1:18790");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("prefix matches the spec", () => {
    expect(CLI_APP_PAIRING_PREFIX).toBe(pairingSpec.prefix);
  });
});
