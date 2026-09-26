import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

/**
 * Every ceremony is a Pages route now (ADR 0140), so the Pages deployment is
 * the one browser origin a ceremony calls from. The retired ceremonies dev
 * server (:5181) and the console's `OPENSESAME_CONSOLE_ORIGIN` are trusted by
 * nothing: an origin is allowed only when `OPENSESAME_CORS_ORIGINS` names it.
 */
describe("Ceremony CORS", () => {
  const pages = ["http://127.0.0.1:5180", "http://localhost:5180"];

  it("allows the configured Pages origin, and only it", () => {
    expect(
      loadConfig({
        OPENSESAME_ENV: "test",
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
        OPENSESAME_CORS_ORIGINS: pages.join(","),
      }).corsOrigins,
    ).toEqual(pages);
  });

  it("trusts neither the retired ceremonies port nor the console origin", () => {
    const config = loadConfig({
      OPENSESAME_ENV: "test",
      OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
      OPENSESAME_CORS_ORIGINS: pages.join(","),
      OPENSESAME_CONSOLE_ORIGIN: "http://127.0.0.1:5173",
      OPENSESAME_CLIENT_APP_URL: "http://localhost:5180/",
    });
    for (const retired of [
      "http://127.0.0.1:5181",
      "http://localhost:5181",
      "http://127.0.0.1:5173",
    ]) {
      expect(config.corsOrigins).not.toContain(retired);
    }
    expect(config.corsOrigins).toEqual(pages);
    // The ceremony origin is where links point, not a CORS grant by itself.
    expect(config.clientAppUrl).toBe("http://localhost:5180/");
  });
});
