import { describe, expect, it } from "vitest";
import { parseJwtPayload } from "./jwt-utils.js";

describe("parseJwtPayload", () => {
  it("adversarial: rejects payloads nested beyond the parser limit", () => {
    let payload = {};
    for (let depth = 0; depth < 34; depth += 1) payload = { nested: payload };

    expect(() => parseJwtPayload(payload)).toThrow("not valid JSON");
  });
});
