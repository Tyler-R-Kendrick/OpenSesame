import { describe, expect, it } from "vitest";
import {
  liveStatus,
  preflightApiKey,
  preflightOauth,
} from "./connect-preflight.mjs";

function answering(statusByPrefix) {
  return async (url) => {
    const status =
      Object.entries(statusByPrefix).find(([prefix]) =>
        String(url).startsWith(prefix),
      )?.[1] ?? 0;
    if (status === 0) throw new Error("unreachable");
    return new Response(null, { status });
  };
}

const OAUTH = {
  service: "example",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  discovery_url: null,
};

describe("connect preflight", () => {
  it("counts a login page, a redirect or invalid_client as live, never 404", () => {
    for (const status of [200, 302, 400, 401, 403])
      expect(liveStatus(status)).toBe(true);
    for (const status of [0, 404, 410, 500])
      expect(liveStatus(status)).toBe(false);
  });

  it("reads an unknown-client 404 as live when the token endpoint answers", async () => {
    const result = await preflightOauth(OAUTH, {
      fetchImpl: answering({
        "https://auth.example.com/authorize": 404,
        "https://auth.example.com/token": 405,
      }),
    });
    expect(result.result).toBe("live_unknown_client_404");
  });

  it("flags an endpoint that is gone", async () => {
    const result = await preflightOauth(OAUTH, {
      fetchImpl: answering({ "https://auth.example.com/authorize": 404 }),
    });
    expect(result.result).toBe("unreachable");
  });

  it("waits for a person's own host before probing a templated endpoint", async () => {
    const result = await preflightOauth(
      { ...OAUTH, authorization_endpoint: "https://{domain}/authorize" },
      { fetchImpl: answering({}) },
    );
    expect(result.result).toBe("needs_account_host");
  });

  it("expects an API to demand a key it was not given", async () => {
    const result = await preflightApiKey(
      {
        service: "k",
        verify: { method: "GET", url: "https://api.example.com/me" },
      },
      { fetchImpl: answering({ "https://api.example.com/me": 401 }) },
    );
    expect(result.result).toBe("live");
  });
});
