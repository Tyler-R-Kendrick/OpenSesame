import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost, env, host } from "./host.js";
import { clearHostForTest, createTestHost } from "./test-host.js";

// The suite's setup installs a host; each case starts from none and the
// next suite gets the setup's host back.
beforeEach(() => clearHostForTest());
afterEach(() => {
  configureHost(createTestHost());
  vi.resetModules();
});

describe("host", () => {
  it("refuses to answer before a host is installed", () => {
    expect(() => host()).toThrow(/no host installed/);
    expect(() => env()).toThrow(/no host installed/);
  });

  it("answers with the installed host's env", () => {
    configureHost(
      createTestHost({ env: { BASE_URL: "/OpenSesame/", DEV: false } }),
    );
    expect(env()).toEqual({ BASE_URL: "/OpenSesame/", DEV: false });
  });

  it("lets a later install replace an earlier one", () => {
    configureHost(createTestHost());
    configureHost(
      createTestHost({ env: { VITE_HOST_API: "https://h.example" } }),
    );
    expect(env().VITE_HOST_API).toBe("https://h.example");
    expect(env().DEV).toBe(true);
  });

  it("is shared with a second copy of this module", async () => {
    configureHost(createTestHost({ env: { BASE_URL: "/copy/" } }));
    vi.resetModules();
    const second = await import("./host.js");
    expect(second.env().BASE_URL).toBe("/copy/");
  });
});
