import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("Pages CORS defaults", () => {
  it("allows either local loopback spelling", () => {
    expect(loadConfig({ OPENSESAME_ENV: "test" }).corsOrigins).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5180",
        "http://localhost:5180",
        "https://tyler-r-kendrick.github.io",
      ]),
    );
  });

  it("keeps the GitHub Pages origin when OPENSESAME_CORS_ORIGINS is set", () => {
    expect(
      loadConfig({
        OPENSESAME_ENV: "test",
        OPENSESAME_CORS_ORIGINS: "http://127.0.0.1:5180,http://localhost:5180",
      }).corsOrigins,
    ).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5180",
        "http://localhost:5180",
        "https://tyler-r-kendrick.github.io",
      ]),
    );
  });
});
