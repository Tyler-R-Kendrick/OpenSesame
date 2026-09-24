import { ENDPOINTS, variableNames } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostApiBase,
  hostAuthHeaders,
  isLoopbackBase,
  resetFetchForTests,
} from "./host-api.js";

const ENV_KEYS: readonly string[] = [
  ...variableNames(ENDPOINTS.host),
  "OPENSESAME_OPERATOR_TOKEN",
  "OPENSESAME_ACCESS_TOKEN",
  "OPENSESAME_HOST_AUDIENCE",
];

describe("host-api fences not covered by the tool suite", () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    resetFetchForTests();
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

  it("refuses agent authority over plaintext http off loopback", async () => {
    stash();
    // biome-ignore lint/performance/noDelete: operator token must not shadow the session path
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
    process.env.OPENSESAME_ACCESS_TOKEN = "sess-1";
    await expect(hostAuthHeaders("http://192.0.2.10:8787")).rejects.toThrow(
      "HTTPS or loopback",
    );
  });

  it("does not promote a native session into agent authority", async () => {
    stash();
    // biome-ignore lint/performance/noDelete: operator token must not shadow the session path
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
    process.env.OPENSESAME_ACCESS_TOKEN = "sess-raw";
    await expect(hostAuthHeaders("https://api.example.test")).rejects.toThrow(
      "approved agent launch",
    );
  });

  it("refuses authenticated calls without an approved launch", async () => {
    stash();
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies
    delete process.env.OPENSESAME_ACCESS_TOKEN;
    await expect(hostAuthHeaders("http://127.0.0.1:8787")).rejects.toThrow(
      "approved agent launch",
    );
  });

  it("reads the Host API from the shared endpoint definition", () => {
    stash();
    for (const name of variableNames(ENDPOINTS.host)) {
      Reflect.deleteProperty(process.env, name);
    }
    expect(hostApiBase()).toBe(ENDPOINTS.host.default);

    process.env[ENDPOINTS.host.aliases[0] ?? ""] = "http://127.0.0.1:9999";
    expect(hostApiBase()).toBe("http://127.0.0.1:9999");

    process.env.OPENSESAME_HOST_API = "https://api.example.test";
    expect(hostApiBase()).toBe("https://api.example.test");
  });
});
