/**
 * The 201 of every route that mints a claim — `POST /v1/claims`,
 * `/v1/projects/temporary`, `/v1/agents` and `/v1/agents/{id}/claim`: the
 * fields they share. Each route adds its own beside them.
 */
export function claimStarted(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: [
            "claimId",
            "claimToken",
            "userCode",
            "verificationUri",
            "expiresAt",
          ],
          properties: {
            claimId: { type: "string" },
            claimToken: {
              type: "string",
              pattern: "^osc_clm_",
              description: "The bearer that presents the claim (ADR 0062).",
            },
            userCode: {
              type: "string",
              description:
                "The second factor the person types; never part of a link.",
            },
            verificationUri: {
              type: "string",
              format: "uri",
              description:
                "The client app's /claim route, or this service's zero-JS /v1/claims/{id}/verify page when none is configured.",
            },
            verificationUriComplete: {
              type: "string",
              format: "uri",
              description:
                "RFC 8628 §3.3.1: verificationUri with the claim token in the fragment (#token=osc_clm_…), so it reaches no request line, log or Referer. Present only with a client app.",
            },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
  };
}

/** Owner-scoped registration administration, separate from AgentAuth OAuth. */
export const agentManagementPaths = {
  "/v1/agents": {
    get: {
      summary: "List owned agent registrations",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Owned registrations only" },
        "401": { description: "Authentication required" },
      },
    },
    post: {
      summary: "Register provisional agent",
      security: [{ bearerAuth: [] }],
      responses: {
        "201": claimStarted("Created"),
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
        "201": claimStarted("Claim started"),
        "401": { description: "Missing principal bearer" },
      },
    },
  },
  "/v1/agents/{id}": {
    patch: {
      summary: "Rename or permanently revoke an owned agent registration",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: {
                displayName: { type: "string", minLength: 1, maxLength: 128 },
                state: { type: "string", enum: ["revoked"] },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Updated owned registration" },
        "400": { description: "Invalid or empty update" },
        "401": { description: "Authentication required" },
        "404": { description: "Unknown or foreign agent" },
        "409": { description: "Registration already revoked" },
      },
    },
  },
};
