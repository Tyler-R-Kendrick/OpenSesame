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
