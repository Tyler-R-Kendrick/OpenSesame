import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildOpenApiDocument } from "../openapi.js";

describe("organization OpenAPI authentication", () => {
  it("documents cookie auth for browser membership and device mutations", () => {
    const document = buildOpenApiDocument(
      loadConfig({ OPENSESAME_ENV: "test" }),
    );
    const paths = document.paths as Record<
      string,
      Record<string, { security?: Array<Record<string, unknown>> }>
    >;

    for (const [path, method] of [
      ["/v1/organizations", "post"],
      ["/v1/organizations/{id}/members", "post"],
      ["/v1/organizations/{id}/members/{principalId}", "patch"],
      ["/v1/organizations/{id}/members/{principalId}", "delete"],
      ["/v1/device/approve", "post"],
    ] as const) {
      expect(
        paths[path]?.[method]?.security,
        `${method.toUpperCase()} ${path}`,
      ).toEqual(
        expect.arrayContaining([{ bearerAuth: [] }, { provisionalCookie: [] }]),
      );
    }
  });
});
