/** @vitest-environment jsdom */
/**
 * The deployment-config boot fetch: a valid file lands in the settings layer,
 * and every failure shape resolves to "no config" without blocking boot.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, runtimeConfigSeams } from "./runtime-config.js";
import { applyRuntimeConfig, loadSettings } from "./settings.js";

const REAL_FETCH = runtimeConfigSeams.fetchRuntimeConfig;

afterEach(() => {
  runtimeConfigSeams.fetchRuntimeConfig = REAL_FETCH;
  applyRuntimeConfig({});
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

describe("loadRuntimeConfig", () => {
  it("applies a fetched identityApi to the settings defaults", async () => {
    runtimeConfigSeams.fetchRuntimeConfig = async () => ({
      identityApi: "https://id.example.com",
    });

    await loadRuntimeConfig();

    expect(loadSettings().identityApi).toBe("https://id.example.com");
  });

  it("leaves settings untouched when no config is served", async () => {
    runtimeConfigSeams.fetchRuntimeConfig = async () => null;
    const before = loadSettings().identityApi;

    await loadRuntimeConfig();

    expect(loadSettings().identityApi).toBe(before);
  });
});

describe("fetchRuntimeConfig", () => {
  it("parses a valid config file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          identityApi: "https://id.example.com",
          hostApi: "https://host.example.com",
          daemonApi: "",
          extra: "ignored",
        }),
      ),
    );

    const config = await REAL_FETCH();

    expect(config).toEqual({
      identityApi: "https://id.example.com",
      hostApi: "https://host.example.com",
      daemonApi: undefined,
      mfaAppUrl: undefined,
    });
  });

  it("answers null for a missing file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    expect(await REAL_FETCH()).toBeNull();
  });

  it("answers null for a body that is not an object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(["nope"])),
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
