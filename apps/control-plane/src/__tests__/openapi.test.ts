import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildOpenApiDocument } from "../openapi.js";

describe("organization OpenAPI authentication", () => {
  it("keeps the generated OpenAPI artifact in sync", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(committed).toEqual(
      buildOpenApiDocument(loadConfig({ OPENSESAME_ENV: "test" })),
    );
  });

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

  it("publishes the organization and approval request/response schemas", () => {
    const document = buildOpenApiDocument(
      loadConfig({ OPENSESAME_ENV: "test" }),
    );
    expect(document).toMatchObject({
      paths: {
        "/v1/organizations": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateOrganization" },
                },
              },
            },
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Organization" },
                  },
                },
              },
            },
          },
        },
        "/v1/organizations/{id}/members": {
          get: {
            responses: {
              "404": {
                description: expect.stringContaining("not_found"),
              },
            },
          },
          post: {
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/OrganizationMembership",
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/organizations/{id}/members/{principalId}": {
          patch: {
            responses: {
              "400": expect.any(Object),
              "404": {
                description: expect.stringContaining("membership_not_found"),
              },
            },
          },
          delete: {
            responses: {
              "404": {
                description: expect.stringContaining("membership_not_found"),
              },
            },
          },
        },
        "/v1/device/approve": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DeviceApproval" },
                },
              },
            },
            responses: {
              "404": expect.any(Object),
              "500": expect.any(Object),
              "503": expect.any(Object),
            },
          },
        },
      },
      components: {
        schemas: {
          Organization: {
            required: expect.arrayContaining([
              "id",
              "role",
              "createdAt",
              "updatedAt",
            ]),
          },
          OrganizationRole: { enum: ["owner", "admin", "member"] },
        },
      },
    });
  });
});
