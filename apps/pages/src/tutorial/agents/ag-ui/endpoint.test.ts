/** @vitest-environment jsdom */
/**
 * The configuration boundary. Absence is the default, https is the only thing
 * allowed to leave a machine, and there is nowhere in here to put a key.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type AgUiEndpointConfig,
  agUiEndpointSeams,
  applyAgUiEndpoint,
  currentAgUiEndpoint,
  loadAgUiEndpoint,
  readAgUiEndpoint,
  readAgUiEndpointUrl,
  resetAgUiEndpointForTest,
} from "./endpoint.js";

const REAL_FETCH = agUiEndpointSeams.fetchAgUiConfig;

afterEach(() => {
  agUiEndpointSeams.fetchAgUiConfig = REAL_FETCH;
  resetAgUiEndpointForTest();
});

describe("readAgUiEndpointUrl", () => {
  it("accepts https anywhere", () => {
    expect(readAgUiEndpointUrl("https://support.example.com/agui")?.url).toBe(
      "https://support.example.com/agui",
    );
  });

  it("accepts http on loopback, where a development endpoint lives", () => {
    expect(readAgUiEndpointUrl("http://localhost:8123/agui")?.url).toBe(
      "http://localhost:8123/agui",
    );
    expect(readAgUiEndpointUrl("http://127.0.0.1:8123")?.url).toBe(
      "http://127.0.0.1:8123",
    );
  });

  it("refuses cleartext to a third party", () => {
    expect(readAgUiEndpointUrl("http://evil.example")).toBeNull();
    expect(readAgUiEndpointUrl("http://evil.example:8080/agui")).toBeNull();
  });

  it("refuses schemes that are not transports", () => {
    expect(readAgUiEndpointUrl("javascript:alert(1)")).toBeNull();
    expect(readAgUiEndpointUrl("javascript:fetch('/')")).toBeNull();
    expect(readAgUiEndpointUrl("file:///etc/passwd")).toBeNull();
    expect(readAgUiEndpointUrl("data:text/plain,hi")).toBeNull();
    expect(readAgUiEndpointUrl("ws://evil.example")).toBeNull();
  });

  it("refuses a scheme-relative reference rather than inheriting our origin", () => {
    expect(readAgUiEndpointUrl("//evil.example")).toBeNull();
    expect(readAgUiEndpointUrl("//evil.example/agui")).toBeNull();
  });

  it("refuses embedded credentials, a query and a fragment", () => {
    expect(
      readAgUiEndpointUrl("https://user:pass@support.example.com"),
    ).toBeNull();
    expect(
      readAgUiEndpointUrl("https://support.example.com?key=abc"),
    ).toBeNull();
    expect(
      readAgUiEndpointUrl("https://support.example.com#key=abc"),
    ).toBeNull();
  });

  it("refuses what is not a URL at all", () => {
    expect(readAgUiEndpointUrl("")).toBeNull();
    expect(readAgUiEndpointUrl("   ")).toBeNull();
    expect(readAgUiEndpointUrl("support.example.com")).toBeNull();
  });

  it("carries content negotiation and no credential", () => {
    const endpoint = readAgUiEndpointUrl("https://support.example.com/agui");
    expect(endpoint).not.toBeNull();
    expect([...(endpoint?.headers.keys() ?? [])].sort()).toEqual([
      "accept",
      "content-type",
    ]);
    for (const name of ["authorization", "cookie", "x-api-key", "api-key"]) {
      expect(endpoint?.headers.has(name)).toBe(false);
    }
  });
});

describe("readAgUiEndpoint", () => {
  it("defaults to absent", () => {
    expect(readAgUiEndpoint(null)).toBeNull();
    expect(readAgUiEndpoint({})).toBeNull();
    expect(readAgUiEndpoint({ supportAgentUrl: "" })).toBeNull();
    expect(readAgUiEndpoint({ supportAgentUrl: "   " })).toBeNull();
  });

  it("validates the configured URL rather than trusting it", () => {
    expect(
      readAgUiEndpoint({ supportAgentUrl: "http://evil.example" }),
    ).toBeNull();
    expect(
      readAgUiEndpoint({ supportAgentUrl: "https://support.example.com" })?.url,
    ).toBe("https://support.example.com");
  });
});

describe("loadAgUiEndpoint", () => {
  it("remembers an accepted endpoint for the synchronous reader", async () => {
    const config: AgUiEndpointConfig = {
      supportAgentUrl: "https://support.example.com/agui",
    };
    agUiEndpointSeams.fetchAgUiConfig = async () => config;

    expect((await loadAgUiEndpoint())?.url).toBe(
      "https://support.example.com/agui",
    );
    expect(currentAgUiEndpoint()?.url).toBe("https://support.example.com/agui");
  });

  it("leaves the transport off when the deploy serves no config", async () => {
    agUiEndpointSeams.fetchAgUiConfig = async () => null;

    expect(await loadAgUiEndpoint()).toBeNull();
    expect(currentAgUiEndpoint()).toBeNull();
  });

  it("leaves the transport off when the configured URL is refused", () => {
    expect(
      applyAgUiEndpoint({ supportAgentUrl: "http://evil.example" }),
    ).toBeNull();
    expect(currentAgUiEndpoint()).toBeNull();
  });
});
