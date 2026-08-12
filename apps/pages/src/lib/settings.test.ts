import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("runtime endpoint defaults", () => {
  it("uses the Host endpoint supplied by the local runtime", async () => {
    vi.stubEnv("VITE_HOST_API", "http://127.0.0.1:18787");
    const { loadSettings } = await import("./settings.js");

    expect(loadSettings().hostApi).toBe("http://127.0.0.1:18787");
    expect(loadSettings().tursoUrl).toBe("");
  });
});
