import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("Ceremonies CORS defaults", () => {
  it("allows explicitly configured loopback origins for ceremonies", () => {
    expect(
      loadConfig({
        OPENSESAME_ENV: "test",
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
        OPENSESAME_CORS_ORIGINS: "http://127.0.0.1:5181,http://localhost:5181",
      }).corsOrigins,
    ).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5181",
        "http://localhost:5181",
      ]),
    );
  });
});
