import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("PWA CORS defaults", () => {
  it("allows explicitly configured loopback origins for the client PWA", () => {
    expect(
      loadConfig({
        OPENSESAME_ENV: "test",
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
        OPENSESAME_CORS_ORIGINS: "http://127.0.0.1:5176,http://localhost:5176",
      }).corsOrigins,
    ).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5176",
        "http://localhost:5176",
      ]),
    );
  });
});
