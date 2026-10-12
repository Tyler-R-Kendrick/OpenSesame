/**
 * Project membership and ownership-transfer paths. The membership blocks moved
 * here from `openapi.ts` unchanged, to keep that file inside its line budget
 * (ADR 0093).
 */

export const projectMemberPaths = {
  "/v1/projects/{id}/members": {
    get: {
      summary: "List project memberships (owner or admin)",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Memberships",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["members"],
                properties: {
                  members: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/ProjectMembership",
                    },
                  },
                },
              },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "403": { description: "Owner or admin role required" },
        "404": { description: "Project or membership not found" },
      },
    },
    post: {
      summary: "Share a project with an existing principal (owner or admin)",
      description:
        "Cookie-authenticated browser mutations also require an allowed Origin header. Personal projects are never shareable.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AddProjectMember" },
          },
        },
      },
      responses: {
        "201": {
          description: "Membership created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProjectMembership" },
            },
          },
        },
        "401": { description: "Authentication or cookie Origin required" },
        "403": { description: "Owner or admin role required" },
        "404": { description: "Principal not found" },
        "409": {
          description:
            "Membership exists, principal is inactive, or project is personal",
        },
      },
    },
  },
  "/v1/projects/{id}/members/{principalId}": {
    patch: {
      summary: "Change a project membership role (owner or admin)",
      description:
        "Cookie-authenticated browser mutations also require an allowed Origin header. Owner grants and revocations take an owner actor.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ChangeProjectMemberRole",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Membership updated",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProjectMembership" },
            },
          },
        },
        "400": { description: "Invalid membership role body" },
        "401": { description: "Authentication or cookie Origin required" },
        "403": { description: "Owner or admin role required" },
        "404": {
          description:
            "Project (`not_found`) or target membership (`membership_not_found`) not found",
        },
        "409": { description: "Last owner cannot be demoted" },
      },
    },
    delete: {
      summary:
        "Remove a project membership (owner or admin, or the member leaving)",
      description:
        "Cookie-authenticated browser mutations also require an allowed Origin header.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "204": { description: "Membership removed" },
        "401": { description: "Authentication or cookie Origin required" },
        "403": { description: "Owner or admin role required" },
        "404": {
          description:
            "Project (`not_found`) or target membership (`membership_not_found`) not found",
        },
        "409": {
          description: "Last owner cannot be removed, or project is personal",
        },
      },
    },
  },
  "/v1/projects/{id}/transfer": {
    post: {
      summary: "Transfer a project to a member or an organization (owner only)",
      description:
        "`confirm` repeats the project slug. A principal recipient must already be an active member; they become owner and the caller stays on as admin. An organization recipient must be one the caller owns. The vault key is not moved. Cookie-authenticated browser mutations also require an allowed Origin header.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["principalId", "confirm"],
                  properties: {
                    principalId: { type: "string", minLength: 1 },
                    confirm: { type: "string", minLength: 1 },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["organizationId", "confirm"],
                  properties: {
                    organizationId: { type: "string", minLength: 1 },
                    confirm: { type: "string", minLength: 1 },
                  },
                },
              ],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Project after the transfer, with the caller's new role",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Project" },
            },
          },
        },
        "400": {
          description:
            "Invalid body, or `confirm` does not match the project slug (`confirmation_mismatch`)",
        },
        "401": { description: "Authentication or cookie Origin required" },
        "403": { description: "Owner role required (`owner_required`)" },
        "404": {
          description: "Project, recipient principal or organization not found",
        },
        "409": {
          description:
            "Personal or temporary project, recipient not an active member, already the owner, or already in that organization",
        },
      },
    },
  },
} as const;
