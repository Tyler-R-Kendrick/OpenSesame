import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("Ceremonies CORS defaults", () => {
  it("allows either local loopback spelling for the ceremonies app", () => {
    expect(loadConfig({ OPENSESAME_ENV: "test" }).corsOrigins).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:5181",
        "http://localhost:5181",
      ]),
    );
  });
});
