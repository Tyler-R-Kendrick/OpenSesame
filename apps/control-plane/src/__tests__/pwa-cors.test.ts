import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("PWA CORS defaults", () => {
  it("allows either local loopback spelling for the client PWA", () => {
    expect(loadConfig({ OPENSESAME_ENV: "test" }).corsOrigins).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5176",
        "http://localhost:5176",
      ]),
    );
  });
});
