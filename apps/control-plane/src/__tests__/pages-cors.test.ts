import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("Pages CORS defaults", () => {
  it("allows either local loopback spelling", () => {
    expect(loadConfig({ OPENSESAME_ENV: "test" }).corsOrigins).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5180",
        "http://localhost:5180",
      ]),
    );
  });
});
