import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("Pages CORS defaults", () => {
  it("trusts no Pages or loopback origin implicitly", () => {
    expect(
      loadConfig({ OPENSESAME_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" })
        .corsOrigins,
    ).toEqual([]);
  });

  it("keeps only explicitly configured origins", () => {
    expect(
      loadConfig({
        OPENSESAME_ENV: "test",
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
        OPENSESAME_CORS_ORIGINS: "http://127.0.0.1:5180,http://localhost:5180",
      }).corsOrigins,
    ).toEqual(["http://127.0.0.1:5180", "http://localhost:5180"]);
  });
});
