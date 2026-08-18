import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient, normalizeLoopbackBaseUrl } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — api-client", () => {
  it("property: loopback bases normalize and remote hosts do not", () => {
    expect(normalizeLoopbackBaseUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeLoopbackBaseUrl("https://evil.example")).toBeNull();
  });

  it("adversarial: probeDaemon never dials a remote daemon", async () => {
    let called = false;
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    const probe = await client.probeDaemon("https://daemon.example.test");
    expect(probe.available).toBe(false);
    expect(called).toBe(false);
  });

  it("chaos: health fetch throw is unavailable, not an open session", async () => {
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async () => {
        throw new Error("partition");
      },
    });
    await expect(client.health()).rejects.toThrow(/partition/);
  });

  it("contract: loopback pin sits before storage in the extension", () => {
    assertSourceOrder(readFileSync(join(here, "index.ts"), "utf8"), [
      "export function normalizeLoopbackBaseUrl",
    ]);
  });
});
