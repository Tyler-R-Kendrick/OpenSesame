/** @vitest-environment jsdom */
/**
 * The deployment-config boot fetch: a valid file lands its core endpoints in
 * the settings layer, an invalid capability section is `invalid` and never a
 * permissive default (TRUST-08), and every failure shape resolves to "no
 * config" without blocking boot.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_POLICIES } from "@opensesame/capability-composition";
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRuntimeConfig,
  parseRuntimeConfig,
  resetRuntimeConfigForTest,
  runtimeConfigSeams,
  runtimeConfigSnapshot,
} from "./runtime-config.js";
import { applyRuntimeConfig, loadSettings } from "./settings.js";

const REAL_FETCH = runtimeConfigSeams.fetchRuntimeConfig;

/** A typed fixture as the untyped JSON a deploy would serve. */
function served(value: unknown): BoundaryValue {
  return JSON.parse(JSON.stringify(value)) as BoundaryValue;
}

afterEach(() => {
  runtimeConfigSeams.fetchRuntimeConfig = REAL_FETCH;
  applyRuntimeConfig({});
  resetRuntimeConfigForTest();
  vi.restoreAllMocks();
});

describe("shipped os-runtime-config.json", () => {
  it("is an empty object so the boot fetch is a 200", () => {
    const shipped = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../public/os-runtime-config.json",
    );
    expect(JSON.parse(readFileSync(shipped, "utf8"))).toEqual({});
  });
});

describe("parseRuntimeConfig", () => {
  it("reads endpoints and leaves the optional sections as data", () => {
    const parsed = parseRuntimeConfig({
      identityApi: " https://id.example.com ",
      hostApi: "https://host.example.com",
      daemonApi: "",
      supportAgentUrl: "https://support.example.com",
      connectCallbackBase: "https://relay.example.com",
      ambientAuth: { providers: [] },
      extra: "ignored",
    });
    expect(parsed.status).toBe("ok");
    expect(parsed.endpoints).toEqual({
      identityApi: "https://id.example.com",
      hostApi: "https://host.example.com",
      supportAgentUrl: "https://support.example.com",
      connectCallbackBase: "https://relay.example.com",
    });
    expect(parsed.ambientAuth).toEqual({ providers: [] });
    expect(parsed.capabilityComposition).toBeNull();
  });

  it("an empty object is a personal-local installation", () => {
    const parsed = parseRuntimeConfig({});
    expect(parsed.status).toBe("ok");
    expect(parsed.capabilityComposition).toBeNull();
    expect(parsed.diagnostics).toEqual([]);
  });

  it("carries a valid instance policy with same-origin provenance", () => {
    const parsed = parseRuntimeConfig(
      served({
        capabilityComposition: {
          schemaVersion: 1,
          instancePolicy: FIXTURE_POLICIES.family,
        },
      }),
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.capabilityComposition?.provenance).toBe(
      "same-origin-deployment",
    );
    expect(parsed.capabilityComposition?.instancePolicy?.instanceId).toBe(
      "fixture-family",
    );
  });

  it("TRUST-08: an invalid capability section is invalid, with a null policy", () => {
    for (const section of [
      "nope",
      { schemaVersion: 2, instancePolicy: FIXTURE_POLICIES.family },
      { schemaVersion: 1 },
      {
        schemaVersion: 1,
        instancePolicy: { kind: "InstanceCapabilityPolicy" },
      },
      { schemaVersion: 1, instancePolicy: null },
    ]) {
      const parsed = parseRuntimeConfig(
        served({ capabilityComposition: section }),
      );
      expect(parsed.status).toBe("invalid");
      expect(parsed.capabilityComposition?.instancePolicy).toBeNull();
      expect(parsed.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("a body that is not an object is invalid", () => {
    expect(parseRuntimeConfig(["nope"]).status).toBe("invalid");
  });
});

describe("loadRuntimeConfig", () => {
  it("applies a fetched identityApi to the settings defaults and keeps the snapshot", async () => {
    runtimeConfigSeams.fetchRuntimeConfig = async () => ({
      identityApi: "https://id.example.com",
      supportAgentUrl: "https://support.example.com",
    });

    const parsed = await loadRuntimeConfig();

    expect(loadSettings().identityApi).toBe("https://id.example.com");
    expect(runtimeConfigSnapshot()).toBe(parsed);
    expect(runtimeConfigSnapshot().endpoints.supportAgentUrl).toBe(
      "https://support.example.com",
    );
  });

  it("still applies core endpoints when the capability section is invalid", async () => {
    runtimeConfigSeams.fetchRuntimeConfig = async () => ({
      identityApi: "https://id.example.com",
      capabilityComposition: "broken",
    });
    const parsed = await loadRuntimeConfig();
    expect(parsed.status).toBe("invalid");
    expect(loadSettings().identityApi).toBe("https://id.example.com");
  });

  it("leaves settings untouched when no config is served", async () => {
    runtimeConfigSeams.fetchRuntimeConfig = async () => null;
    const before = loadSettings().identityApi;

    const parsed = await loadRuntimeConfig();

    expect(parsed.status).toBe("absent");
    expect(loadSettings().identityApi).toBe(before);
  });
});

describe("fetchRuntimeConfig", () => {
  it("returns the raw body of a valid config file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ identityApi: "https://id.example.com" }),
      ),
    );
    expect(await REAL_FETCH()).toEqual({
      identityApi: "https://id.example.com",
    });
  });

  it("answers null for a missing file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    expect(await REAL_FETCH()).toBeNull();
  });

  it("answers null when the fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await REAL_FETCH()).toBeNull();
  });
});
