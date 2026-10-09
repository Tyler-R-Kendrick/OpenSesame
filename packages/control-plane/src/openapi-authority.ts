/** GA-I-01 Identity authority spawn + PoP enrollment paths. */

const unauthorized = {
  "401": { description: "Authentication required" },
} as const;

export const authorityPaths = {
  "/v1/authority/workloads/spawn": {
    post: {
      summary: "Spawn a workload identity under the caller's orchestrator",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "orchestratorKind",
                "orchestratorPrincipalId",
                "realmId",
                "taskId",
                "accessDomainId",
                "runtimeProfile",
                "authorityGeneration",
                "publicKeyJkt",
              ],
              properties: {
                orchestratorKind: {
                  type: "string",
                  enum: ["agent_registration", "actor_instance", "service"],
                },
                orchestratorPrincipalId: { type: "string", maxLength: 256 },
                realmId: { type: "string", maxLength: 256 },
                taskId: { type: "string", maxLength: 256 },
                accessDomainId: { type: "string", maxLength: 256 },
                runtimeProfile: { type: "string", maxLength: 64 },
                authorityGeneration: { type: "integer", minimum: 1 },
                publicKeyJkt: { type: "string", minLength: 8, maxLength: 256 },
                ordinal: { type: "integer", minimum: 0 },
                restoredFromGeneration: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Workload identity spawned" },
        "400": { description: "Validation or invariant violation" },
        "403": { description: "Orchestrator must be the caller" },
        ...unauthorized,
      },
    },
  },
  "/v1/authority/enrollment/pop": {
    post: {
      summary:
        "Bind proof-of-possession for a device, actor, or workload subject",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "subjectKind",
                "principalId",
                "realmId",
                "publicKeyJkt",
                "authorityGeneration",
              ],
              properties: {
                subjectKind: {
                  type: "string",
                  enum: ["actor_instance", "device", "workload_instance"],
                },
                principalId: { type: "string", maxLength: 256 },
                realmId: {
                  type: "string",
                  maxLength: 256,
                  description:
                    "Organization realm; caller must be owner or admin",
                },
                publicKeyJkt: { type: "string", minLength: 8, maxLength: 256 },
                authorityGeneration: { type: "integer", minimum: 1 },
                expiresAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "PoP enrollment bound" },
        "400": { description: "Validation or invariant violation" },
        "403": { description: "Caller is not a realm owner or admin" },
        ...unauthorized,
      },
    },
  },
} as const;
