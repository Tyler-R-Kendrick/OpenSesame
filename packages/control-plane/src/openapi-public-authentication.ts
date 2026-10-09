import { hostAuthorizationPaths } from "./openapi-host-authorization.js";

export const publicAuthenticationPaths = {
  ...hostAuthorizationPaths,
  "/v1/support": {
    head: {
      summary: "Check the authenticated same-origin support session",
      responses: {
        "204": {
          description: "Active session; X-OpenSesame-Support-Session: active",
        },
        "401": { description: "Validated session required" },
        "404": { description: "Remote support disabled" },
      },
    },
    post: {
      summary: "Send a preview-approved, redacted support request",
      description:
        "Requires an active session and exact same-origin POST. Remote support is optional and disabled without server configuration.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "version",
                "question",
                "pageId",
                "route",
                "featureIds",
              ],
              properties: {
                version: { const: 2 },
                question: { type: "string", minLength: 1, maxLength: 2000 },
                pageId: { type: "string", maxLength: 64 },
                route: { type: "string", maxLength: 65 },
                featureIds: {
                  type: "array",
                  maxItems: 32,
                  items: { type: "string", maxLength: 64 },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Bounded AG-UI SSE response" },
        "400": { description: "Invalid closed payload" },
        "401": { description: "Validated session required" },
        "403": { description: "Origin refused" },
        "413": { description: "Payload exceeds 8KiB" },
        "502": { description: "Upstream unavailable" },
      },
    },
  },
  "/v1/authentication/public/applications/{applicationId}/register/options": {
    parameters: [
      {
        name: "applicationId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
        description:
          "Active application; body applicationId must match exactly. Only registered exact origins are admitted.",
      },
    ],
    post: {
      summary: "Start a WebAuthn registration ceremony",
      responses: {
        "200": { description: "PublicKeyCredentialCreationOptionsJSON" },
        "403": { description: "Origin or token denied" },
      },
    },
  },
  "/v1/authentication/public/applications/{applicationId}/register/verify": {
    parameters: [
      {
        name: "applicationId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
        description:
          "Active application; body applicationId must match exactly. Only registered exact origins are admitted.",
      },
    ],
    post: {
      summary: "Verify and persist a WebAuthn registration",
      responses: {
        "201": { description: "Credential registered" },
        "400": { description: "Invalid attestation" },
      },
    },
  },
  "/v1/authentication/public/applications/{applicationId}/signin/options": {
    parameters: [
      {
        name: "applicationId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
        description:
          "Active application; body applicationId must match exactly. Only registered exact origins are admitted.",
      },
    ],
    post: {
      summary: "Start autofill, discoverable, alias, or user-ID sign-in",
      responses: {
        "200": { description: "PublicKeyCredentialRequestOptionsJSON" },
        "404": { description: "User or policy not found" },
      },
    },
  },
  "/v1/authentication/public/applications/{applicationId}/signin/verify": {
    parameters: [
      {
        name: "applicationId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
        description:
          "Active application; body applicationId must match exactly. Only registered exact origins are admitted.",
      },
    ],
    post: {
      summary: "Verify a WebAuthn assertion and mint a one-time result",
      responses: {
        "200": { description: "Authentication result token" },
        "400": { description: "Invalid assertion" },
      },
    },
  },
};
