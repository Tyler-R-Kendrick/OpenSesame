import type { ControlPlaneConfig } from "./config.js";

const authenticationUnauthorizedResponse = {
  "401": { description: "Authentication required" },
} as const;

/** Minimal OpenAPI 3.1 document for product APIs. */
export function buildOpenApiDocument(config: ControlPlaneConfig) {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenSesame Control Plane",
      version: "0.1.0",
      description:
        "Identity, claims, provisional principals, and agent registration APIs",
    },
    servers: [{ url: config.publicUrl }],
    paths: {
      "/v1/health/live": {
        get: {
          summary: "Liveness probe",
          responses: { "200": { description: "Alive" } },
        },
      },
      "/v1/health/ready": {
        get: {
          summary: "Readiness probe",
          responses: {
            "200": { description: "Ready" },
            "503": { description: "Not ready" },
          },
        },
      },
      "/v1/principals/provisional": {
        post: {
          summary: "Create provisional principal + session",
          responses: {
            "201": { description: "Created" },
            "429": { description: "Rate fence" },
          },
        },
      },
      "/v1/principals/me": {
        get: {
          summary: "Current principal",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          responses: {
            "200": { description: "Principal" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/v1/organizations": {
        get: {
          summary:
            "List organizations the caller belongs to, including their role",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          responses: {
            "200": {
              description: "Organizations and caller roles",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["organizations"],
                    properties: {
                      organizations: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Organization" },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
          },
        },
        post: {
          summary: "Create an organization; the creator becomes owner",
          description:
            "Cookie-authenticated browser mutations also require an allowed Origin header.",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateOrganization" },
              },
            },
          },
          responses: {
            "201": {
              description: "Organization created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "400": { description: "Invalid organization body" },
            "401": { description: "Authentication or cookie Origin required" },
            "403": { description: "Verified identity required" },
            "409": { description: "Slug already exists" },
          },
        },
      },
      "/v1/organizations/tenants/{slug}": {
        get: {
          summary:
            "Public tenant discovery: display name and SSO/SAML login methods",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Tenant auth methods",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/OrganizationTenant" },
                },
              },
            },
            "404": { description: "Tenant not found" },
          },
        },
      },
      "/v1/organizations/tenants/{slug}/join": {
        post: {
          summary:
            "Join a tenant after SSO/SAML (OIDC-brokered) by presenting an id_token",
          description:
            "Provisional principals may join. SAML is an OIDC broker issuer (ADR 0016).",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          parameters: [
            {
              name: "slug",
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
                  $ref: "#/components/schemas/JoinOrganizationTenant",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Already a member",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "201": {
              description: "Joined as member",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "400": { description: "Invalid join body" },
            "401": { description: "Authentication or assertion required" },
            "404": { description: "Tenant not found" },
            "409": { description: "Requested auth method is not configured" },
            "502": { description: "Org issuer discovery failed" },
          },
        },
      },
      "/v1/organizations/{id}": {
        get: {
          summary:
            "Get an organization the caller belongs to, including their role",
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
              description: "Organization",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "404": { description: "Organization or membership not found" },
          },
        },
        patch: {
          summary: "Update organization display name or SSO/SAML issuers",
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
                schema: { $ref: "#/components/schemas/UpdateOrganization" },
              },
            },
          },
          responses: {
            "200": {
              description: "Organization updated",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "400": { description: "Invalid organization body" },
            "401": { description: "Authentication required" },
            "403": { description: "Owner required" },
            "404": { description: "Organization or membership not found" },
          },
        },
      },
      "/v1/organizations/{id}/members": {
        get: {
          summary: "List organization memberships (owner only)",
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
                          $ref: "#/components/schemas/OrganizationMembership",
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Owner role required" },
            "404": {
              description: "Caller membership not found (`not_found`)",
            },
          },
        },
        post: {
          summary: "Add an existing principal to an organization (owner only)",
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
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AddOrganizationMember" },
              },
            },
          },
          responses: {
            "201": {
              description: "Membership created",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/OrganizationMembership",
                  },
                },
              },
            },
            "401": { description: "Authentication or cookie Origin required" },
            "403": { description: "Owner role required" },
            "404": { description: "Principal not found" },
            "409": {
              description: "Membership exists or principal is inactive",
            },
          },
        },
      },
      "/v1/organizations/{id}/members/{principalId}": {
        patch: {
          summary:
            "Change a membership role and revoke its Host sessions (owner only)",
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
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChangeOrganizationMemberRole",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Membership updated",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/OrganizationMembership",
                  },
                },
              },
            },
            "401": { description: "Authentication or cookie Origin required" },
            "400": { description: "Invalid membership role body" },
            "403": { description: "Owner role required" },
            "404": {
              description:
                "Caller membership (`not_found`) or target membership (`membership_not_found`) not found",
            },
            "409": { description: "Last owner cannot be demoted" },
            "502": {
              description: "Host session revocation failed; role unchanged",
            },
          },
        },
        delete: {
          summary:
            "Remove a membership and revoke its Host sessions (owner only)",
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
            "403": { description: "Owner role required" },
            "404": {
              description:
                "Caller membership (`not_found`) or target membership (`membership_not_found`) not found",
            },
            "409": { description: "Last owner cannot be removed" },
            "502": {
              description:
                "Host session revocation failed; membership unchanged",
            },
          },
        },
      },
      "/v1/device/approve": {
        post: {
          summary:
            "Approve a Host device session in an organization the caller belongs to",
          description:
            "Identity derives the organization role server-side; organization_role and principal fields supplied by browsers are ignored. Cookie-authenticated browser mutations also require an allowed Origin header.",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeviceApproval" },
              },
            },
          },
          responses: {
            "200": {
              description: "Device approved",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DeviceApprovalResult" },
                },
              },
            },
            "401": { description: "Authentication or cookie Origin required" },
            "400": {
              description: "Organization selection required or request invalid",
            },
            "403": {
              description: "Caller is not an active member of the organization",
            },
            "404": { description: "Host device authorization not found" },
            "500": { description: "Configured Host API URL is invalid" },
            "502": { description: "Host API unavailable" },
            "503": { description: "Host operator token is not configured" },
          },
        },
      },
      "/v1/projects": {
        get: {
          summary:
            "List projects the caller can use, provisioning the personal default on first touch",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          responses: {
            "200": {
              description: "Projects and caller roles, personal project first",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["projects"],
                    properties: {
                      projects: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Project" },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
          },
        },
        post: {
          summary: "Create a project; the creator becomes owner",
          description:
            "Cookie-authenticated browser mutations also require an allowed Origin header.",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateProject" },
              },
            },
          },
          responses: {
            "201": {
              description: "Project created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Project" },
                },
              },
            },
            "400": { description: "Invalid project body" },
            "401": { description: "Authentication or cookie Origin required" },
            "403": { description: "Verified identity or quota required" },
            "404": { description: "Organization not found" },
            "409": { description: "Slug already exists" },
          },
        },
      },
      "/v1/projects/active": {
        get: {
          summary:
            "Currently active project (falls back to the personal project)",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          responses: {
            "200": {
              description: "Active project",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ActiveProject" },
                },
              },
            },
            "401": { description: "Unauthorized" },
          },
        },
        put: {
          summary: "Swap the caller's active project",
          description:
            "Cookie-authenticated browser mutations also require an allowed Origin header.",
          security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SetActiveProject" },
              },
            },
          },
          responses: {
            "200": {
              description: "Active project swapped",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ActiveProject" },
                },
              },
            },
            "400": { description: "Invalid body" },
            "401": { description: "Authentication or cookie Origin required" },
            "404": { description: "Project or membership not found" },
          },
        },
      },
      "/v1/projects/temporary": {
        post: {
          summary: "Create temporary provisional project",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              schema: { type: "string" },
            },
          ],
          responses: {
            "201": { description: "Created" },
            "401": { description: "Missing principal bearer" },
            "403": { description: "Quota exceeded" },
          },
        },
      },
      "/v1/projects/{id}": {
        get: {
          summary: "Get a project the caller can use, including their role",
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
              description: "Project",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Project" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "404": { description: "Project or membership not found" },
          },
        },
        delete: {
          summary: "Delete a project (owner only; the personal project never)",
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
          ],
          responses: {
            "204": { description: "Project deleted" },
            "401": { description: "Authentication or cookie Origin required" },
            "403": { description: "Owner role required" },
            "404": { description: "Project or membership not found" },
            "409": { description: "Personal project cannot be deleted" },
          },
        },
      },
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
          summary:
            "Share a project with an existing principal (owner or admin)",
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
              description:
                "Last owner cannot be removed, or project is personal",
            },
          },
        },
      },
      "/v1/claims": {
        post: {
          summary: "Create claim",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              schema: { type: "string" },
            },
          ],
          responses: {
            "201": { description: "Created" },
            "401": { description: "Missing principal bearer" },
            "403": { description: "Quota exceeded" },
          },
        },
      },
      "/v1/claims/{id}": {
        get: {
          summary: "Get claim",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "X-Claim-Token",
              in: "header",
              required: true,
              schema: { type: "string", pattern: "^osc_clm_" },
              description: "Claim bearer (or Authorization: Bearer osc_clm_…)",
            },
          ],
          responses: {
            "200": { description: "Claim" },
            "401": { description: "Missing/invalid claim token" },
          },
        },
      },
      "/v1/claims/present": {
        post: {
          summary: "Present claim token",
          responses: {
            "200": { description: "Presented" },
            "401": { description: "Missing or invalid claim token" },
          },
        },
      },
      "/v1/claims/{id}/complete": {
        post: {
          summary: "Complete claim",
          description:
            "Requires the user code displayed by the device being claimed; five wrong codes refuse the claim.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "Idempotency-Key",
              in: "header",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["acceptedItemIds", "userCode"],
                  properties: {
                    acceptedItemIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                    userCode: { type: "string" },
                    destination: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Completed" },
            "401": { description: "Missing or wrong user code" },
            "429": { description: "Too many wrong user codes for this claim" },
          },
        },
      },
      "/v1/claims/{id}/deny": {
        post: {
          summary: "Deny claim",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Denied" },
            "401": { description: "Missing principal bearer" },
          },
        },
      },
      "/v1/claims/{id}/poll": {
        get: {
          summary: "Poll claim status",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "X-Claim-Token",
              in: "header",
              required: true,
              schema: { type: "string", pattern: "^osc_clm_" },
              description: "Claim bearer (or Authorization: Bearer osc_clm_…)",
            },
          ],
          responses: {
            "200": { description: "Status" },
            "401": { description: "Missing/invalid claim token" },
          },
        },
      },
      "/v1/agents": {
        post: {
          summary: "Register provisional agent",
          security: [{ bearerAuth: [] }],
          responses: {
            "201": { description: "Created" },
            "401": { description: "Missing principal bearer" },
            "403": { description: "Quota exceeded" },
          },
        },
      },
      "/v1/agents/{id}/claim": {
        post: {
          summary: "Start claim for agent",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "201": { description: "Claim started" },
            "401": { description: "Missing principal bearer" },
          },
        },
      },
      "/auth.md": {
        get: {
          summary: "Generated auth surface markdown",
          responses: { "200": { description: "Markdown" } },
        },
      },
      "/.well-known/agent-card.json": {
        get: {
          summary: "A2A agent card",
          responses: { "200": { description: "Agent card" } },
        },
      },
      "/.well-known/oauth-protected-resource": {
        get: {
          summary: "RFC 9728 protected resource metadata",
          responses: { "200": { description: "Metadata" } },
        },
      },
      "/v1/mfa/passkey/assert": {
        post: {
          summary: "Verify a passkey assertion (unauthenticated, fenced)",
          responses: {
            "200": { description: "Assertion accepted" },
            "400": { description: "Invalid request" },
            "401": { description: "Assertion failed" },
            "429": { description: "Rate fence" },
          },
        },
      },
      "/v1/authentication/applications": {
        get: {
          summary: "List managed passwordless applications",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Applications" },
            "401": { description: "Unauthorized" },
          },
        },
        post: {
          summary:
            "Create a passwordless application and shown-once API secret",
          security: [{ bearerAuth: [] }],
          responses: {
            "201": { description: "Application and API secret" },
            ...authenticationUnauthorizedResponse,
            "403": { description: "Verified administrator required" },
          },
        },
      },
      "/v1/authentication/applications/{applicationId}": {
        patch: {
          summary:
            "Update application state, features, or authentication policies",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "applicationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Application updated" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/authentication/applications/{applicationId}/rotate-secret": {
        post: {
          summary: "Replace all backend API keys with one shown-once secret",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "applicationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Secret rotated" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/authentication/applications/{applicationId}/api-keys": {
        post: {
          summary: "Create an additional shown-once backend API key",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "applicationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "201": { description: "API key created" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/authentication/applications/{applicationId}/api-keys/{keyId}": {
        patch: {
          summary: "Lock or unlock a backend API key",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "applicationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "keyId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "API key updated" },
            ...authenticationUnauthorizedResponse,
            "409": { description: "Last active key" },
          },
        },
        delete: {
          summary: "Delete a locked backend API key",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "applicationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "keyId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "API key deleted" },
            ...authenticationUnauthorizedResponse,
            "409": { description: "Lock key first" },
          },
        },
      },
      "/v1/authentication/backend/registration-tokens": {
        post: {
          summary: "Create a one-time passkey registration token",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "201": { description: "Registration token" },
            ...authenticationUnauthorizedResponse,
          },
        },
      },
      "/v1/authentication/backend/signin/generate-token": {
        post: {
          summary: "Generate a manual authentication token",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "201": { description: "Authentication token" },
            ...authenticationUnauthorizedResponse,
            "403": { description: "Feature disabled" },
          },
        },
      },
      "/v1/authentication/backend/signin/verify-token": {
        post: {
          summary: "Exchange an authentication result exactly once",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "200": { description: "Verified application user" },
            ...authenticationUnauthorizedResponse,
            "403": { description: "Invalid or consumed token" },
          },
        },
      },
      "/v1/authentication/backend/aliases": {
        post: {
          summary: "Replace a user's aliases, hashed by default",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "204": { description: "Aliases replaced" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "User not found" },
          },
        },
      },
      "/v1/authentication/backend/credentials/list": {
        post: {
          summary: "List public passkey credentials for an application user",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "200": { description: "Credentials" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "User not found" },
          },
        },
      },
      "/v1/authentication/backend/credentials/delete": {
        post: {
          summary: "Revoke a passkey credential",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "204": { description: "Credential revoked" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Credential not found" },
          },
        },
      },
      "/v1/authentication/backend/magic-links/send": {
        post: {
          summary:
            "Send a one-time authentication link through the configured mailer",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "204": { description: "Message sent" },
            ...authenticationUnauthorizedResponse,
            "403": { description: "Feature or origin denied" },
            "503": { description: "Mail delivery failed" },
          },
        },
      },
      "/v1/authentication/backend/auth-configurations": {
        get: {
          summary: "List authentication configurations",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "200": { description: "Configurations" },
            ...authenticationUnauthorizedResponse,
          },
        },
        post: {
          summary: "Create an authentication configuration",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "201": { description: "Configuration created" },
            ...authenticationUnauthorizedResponse,
            "409": { description: "Purpose exists" },
          },
        },
      },
      "/v1/authentication/backend/auth-configurations/{purpose}": {
        patch: {
          summary: "Update an authentication configuration",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "204": { description: "Configuration updated" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Purpose not found" },
          },
        },
        delete: {
          summary: "Delete a custom authentication configuration",
          security: [{ authenticationApiSecret: [] }],
          responses: {
            "204": { description: "Configuration deleted" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Purpose not found" },
            "409": { description: "Built-in configuration" },
          },
        },
      },
      "/v1/authentication/applications/{applicationId}/users": {
        get: {
          summary: "List application users, aliases, and credentials",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Users" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/authentication/applications/{applicationId}/credentials/{credentialId}":
        {
          patch: {
            summary: "Rename an application credential",
            security: [{ bearerAuth: [] }],
            responses: {
              "200": { description: "Credential renamed" },
              ...authenticationUnauthorizedResponse,
              "404": { description: "Not found" },
            },
          },
          delete: {
            summary: "Revoke an application credential",
            security: [{ bearerAuth: [] }],
            responses: {
              "200": { description: "Credential revoked" },
              ...authenticationUnauthorizedResponse,
              "404": { description: "Not found" },
            },
          },
        },
      "/v1/authentication/applications/{applicationId}/events": {
        get: {
          summary: "List tamper-evident application authentication events",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Events" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/authentication/organizations/{organizationId}/events": {
        get: {
          summary: "List organization authentication events",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Events" },
            ...authenticationUnauthorizedResponse,
            "404": { description: "Not found" },
          },
        },
      },
      "/v1/authentication/public/register/options": {
        post: {
          summary: "Start a WebAuthn registration ceremony",
          responses: {
            "200": { description: "PublicKeyCredentialCreationOptionsJSON" },
            "403": { description: "Origin or token denied" },
          },
        },
      },
      "/v1/authentication/public/register/verify": {
        post: {
          summary: "Verify and persist a WebAuthn registration",
          responses: {
            "201": { description: "Credential registered" },
            "400": { description: "Invalid attestation" },
          },
        },
      },
      "/v1/authentication/public/signin/options": {
        post: {
          summary: "Start autofill, discoverable, alias, or user-ID sign-in",
          responses: {
            "200": { description: "PublicKeyCredentialRequestOptionsJSON" },
            "404": { description: "User or policy not found" },
          },
        },
      },
      "/v1/authentication/public/signin/verify": {
        post: {
          summary: "Verify a WebAuthn assertion and mint a one-time result",
          responses: {
            "200": { description: "Authentication result token" },
            "400": { description: "Invalid assertion" },
          },
        },
      },
    },
    components: {
      schemas: {
        OrganizationState: {
          type: "string",
          enum: ["provisional", "active", "suspended", "deleted"],
        },
        OrganizationRole: {
          type: "string",
          enum: ["owner", "admin", "member"],
        },
        CreateOrganization: {
          type: "object",
          additionalProperties: false,
          required: ["slug", "displayName"],
          properties: {
            slug: {
              type: "string",
              minLength: 2,
              maxLength: 64,
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            },
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            ssoIssuer: { type: "string", format: "uri" },
            samlIssuer: { type: "string", format: "uri" },
          },
        },
        UpdateOrganization: {
          type: "object",
          additionalProperties: false,
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            ssoIssuer: { type: ["string", "null"], format: "uri" },
            // What this deployment authenticates as at the tenant's own IdP.
            // Without them the leg falls back to the origin-profile client,
            // which Okta, Entra, Google Workspace and Auth0 all refuse.
            ssoClientId: { type: ["string", "null"], maxLength: 256 },
            // Write-only: never returned, because it must reach the tenant's
            // token endpoint as issued and there is no digest to show.
            ssoClientSecret: { type: ["string", "null"], maxLength: 1024 },
            samlIssuer: { type: ["string", "null"], format: "uri" },
          },
        },
        OrganizationAuthMethod: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "label", "issuer"],
          properties: {
            kind: { type: "string", enum: ["sso", "saml"] },
            label: { type: "string" },
            issuer: { type: "string", format: "uri" },
          },
        },
        OrganizationTenant: {
          type: "object",
          additionalProperties: false,
          required: ["slug", "displayName", "state", "authMethods"],
          properties: {
            slug: { type: "string" },
            displayName: { type: "string" },
            state: { $ref: "#/components/schemas/OrganizationState" },
            authMethods: {
              type: "array",
              items: { $ref: "#/components/schemas/OrganizationAuthMethod" },
            },
          },
        },
        JoinOrganizationTenant: {
          type: "object",
          additionalProperties: false,
          required: ["method", "idToken"],
          properties: {
            method: { type: "string", enum: ["sso", "saml"] },
            idToken: { type: "string" },
          },
        },
        Organization: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "slug",
            "displayName",
            "state",
            "role",
            "createdBy",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            displayName: { type: "string" },
            state: { $ref: "#/components/schemas/OrganizationState" },
            role: { $ref: "#/components/schemas/OrganizationRole" },
            createdBy: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            ssoIssuer: { type: "string", format: "uri" },
            ssoClientId: { type: "string" },
            // Whether a secret is stored — deliberately not the secret.
            ssoClientSecretConfigured: { type: "boolean" },
            samlIssuer: { type: "string", format: "uri" },
          },
        },
        OrganizationMembership: {
          type: "object",
          additionalProperties: false,
          required: [
            "organizationId",
            "principalId",
            "role",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            organizationId: { type: "string" },
            principalId: { type: "string" },
            role: { $ref: "#/components/schemas/OrganizationRole" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AddOrganizationMember: {
          type: "object",
          additionalProperties: false,
          required: ["principalId", "role"],
          properties: {
            principalId: { type: "string", minLength: 1 },
            role: { $ref: "#/components/schemas/OrganizationRole" },
          },
        },
        ChangeOrganizationMemberRole: {
          type: "object",
          additionalProperties: false,
          required: ["role"],
          properties: {
            role: { $ref: "#/components/schemas/OrganizationRole" },
          },
        },
        ProjectState: {
          type: "string",
          enum: ["provisional", "active", "expired", "deleting", "deleted"],
        },
        ProjectKind: {
          type: "string",
          enum: ["personal", "standard", "temporary"],
        },
        ProjectRole: {
          type: "string",
          enum: ["owner", "admin", "member"],
        },
        CreateProject: {
          type: "object",
          additionalProperties: false,
          required: ["displayName"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            slug: {
              type: "string",
              minLength: 2,
              maxLength: 64,
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            },
            organizationId: { type: "string" },
          },
        },
        Project: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "kind",
            "slug",
            "displayName",
            "state",
            "role",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string" },
            kind: { $ref: "#/components/schemas/ProjectKind" },
            slug: { type: "string" },
            displayName: { type: "string" },
            state: { $ref: "#/components/schemas/ProjectState" },
            role: { $ref: "#/components/schemas/ProjectRole" },
            ownerPrincipalId: { type: "string" },
            organizationId: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        ActiveProject: {
          type: "object",
          additionalProperties: false,
          required: ["project", "isFallback"],
          properties: {
            project: { $ref: "#/components/schemas/Project" },
            isFallback: {
              type: "boolean",
              description:
                "True when the active project fell back to the personal default.",
            },
          },
        },
        SetActiveProject: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
          },
        },
        ProjectMembership: {
          type: "object",
          additionalProperties: false,
          required: [
            "projectId",
            "principalId",
            "role",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            projectId: { type: "string" },
            principalId: { type: "string" },
            role: { $ref: "#/components/schemas/ProjectRole" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AddProjectMember: {
          type: "object",
          additionalProperties: false,
          required: ["principalId", "role"],
          properties: {
            principalId: { type: "string", minLength: 1 },
            role: { $ref: "#/components/schemas/ProjectRole" },
          },
        },
        ChangeProjectMemberRole: {
          type: "object",
          additionalProperties: false,
          required: ["role"],
          properties: {
            role: { $ref: "#/components/schemas/ProjectRole" },
          },
        },
        DeviceApproval: {
          type: "object",
          required: ["user_code"],
          properties: {
            user_code: { type: "string", minLength: 1 },
            organization_id: { type: "string" },
          },
        },
        DeviceApprovalResult: {
          type: "object",
          required: ["ok", "status", "body"],
          properties: {
            ok: { type: "boolean" },
            status: { type: "integer", minimum: 100, maximum: 599 },
            body: {},
          },
        },
      },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        authenticationApiSecret: {
          type: "http",
          scheme: "bearer",
          description: "Shown-once osa_ backend API secret",
        },
        provisionalCookie: {
          type: "apiKey",
          in: "cookie",
          name: "os_provisional",
        },
      },
    },
  };
}
