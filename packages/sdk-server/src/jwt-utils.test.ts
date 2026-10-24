import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { AuthError } from "./errors.js";
import { assertAllowedJwtAlgorithm, parseJwtPayload } from "./jwt-utils.js";

function tokenWithHeader(header: JsonObject): string {
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.`;
}

describe("parseJwtPayload", () => {
  it("adversarial: rejects payloads nested beyond the parser limit", () => {
    let payload = {};
    for (let depth = 0; depth < 34; depth += 1) payload = { nested: payload };

    expect(() => parseJwtPayload(payload)).toThrow("not valid JSON");
  });
});

describe("assertAllowedJwtAlgorithm", () => {
  it.each([[123], [null], [{}], [["ES256"]]])(
    "rejects a non-string alg header without a TypeError: %j",
    (alg) => {
      expect(() => assertAllowedJwtAlgorithm(tokenWithHeader({ alg }))).toThrow(
        AuthError,
      );
    },
  );
});
