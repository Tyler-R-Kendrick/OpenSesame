import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import * as kv from "./kv.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export function installNativeApiTests(): void {
  beforeEach(() => {
    kv.kvForgetAll();
    const memory = new Map<string, string>();
    vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
      (key) => memory.get(key) ?? null,
    );
    vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
      async (key, value) => {
        memory.set(key, value);
      },
    );
    vi.spyOn(kv, "kvDurability").mockReturnValue("persistent");
    vi.spyOn(kv, "kvRefresh").mockResolvedValue(undefined);
    configureHost(createTestHost({ locks: overlapCast(webLocksDouble()) }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureHost(createTestHost());
  });
}
export function nativeAnswers(
  ...replies: { body: BoundaryValue; status?: number }[]
) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const response = replies.shift();
    if (!response) throw new Error("No provider response remaining");
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const assertCurrent = vi.fn();
  const transport: NativeProviderTransport = { fetch, assertCurrent };
  return { transport, fetch, assertCurrent };
}
export const nativeApiDraft = (providerId = "notion") => ({
  providerId,
  displayName: "Team API",
  parameters: {},
  credentials: { api_key: "private-native-key" },
});
