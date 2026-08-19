import { afterEach, describe, expect, it } from "vitest";
import { hostApiBase, hostAuthHeaders, isLoopbackBase } from "./host-api.js";

const ENV_KEYS = [
  "OPENSESAME_SERVER",
  "OPENSESAME_HOST_API",
  "OPENSESAME_OPERATOR_TOKEN",
  "OPENSESAME_ACCESS_TOKEN",
  "OPENSESAME_HOST_AUDIENCE",
] as const;

describe("host-api fences not covered by the tool suite", () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
  });

  function stash() {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  }

  it("treats an unparseable base as non-loopback", () => {
    expect(isLoopbackBase("not a url")).toBe(false);
  });

  it("refuses a session token over plaintext http off loopback", () => {
    stash();
    // biome-ignore lint/performance/noDelete: operator token must not shadow the session path
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
    process.env.OPENSESAME_ACCESS_TOKEN = "sess-1";
    expect(() => hostAuthHeaders("http://192.0.2.10:8787")).toThrow(
      "requires https off loopback",
    );
  });

  it("prefixes a bare session token with opaque-session:", () => {
    stash();
    // biome-ignore lint/performance/noDelete: operator token must not shadow the session path
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
    process.env.OPENSESAME_ACCESS_TOKEN = "sess-raw";
    expect(hostAuthHeaders("https://api.example.test").authorization).toBe(
      "Bearer opaque-session:sess-raw",
    );
  });

  it("sends no authorization header when no token is configured", () => {
    stash();
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies
    delete process.env.OPENSESAME_ACCESS_TOKEN;
    expect(hostAuthHeaders("http://127.0.0.1:8787")).toEqual({});
  });

  it("prefers OPENSESAME_SERVER, then OPENSESAME_HOST_API, then the loopback default", () => {
    stash();
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies
    delete process.env.OPENSESAME_SERVER;
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies
    delete process.env.OPENSESAME_HOST_API;
    expect(hostApiBase()).toBe("http://127.0.0.1:8787");

    process.env.OPENSESAME_HOST_API = "http://127.0.0.1:9999";
    expect(hostApiBase()).toBe("http://127.0.0.1:9999");

    process.env.OPENSESAME_SERVER = "https://api.example.test";
    expect(hostApiBase()).toBe("https://api.example.test");
  });
});
