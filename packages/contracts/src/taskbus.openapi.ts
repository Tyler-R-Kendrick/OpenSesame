/**
 * OpenAPI-shaped contract for Host operator TaskBus routes.
 * Kept in sync with `apps/gateway` handlers and Zod schemas in `./taskbus.ts`.
 */
export const taskBusOpenApi = {
  openapi: "3.0.3",
  info: {
    title: "OpenSesame Host TaskBus operator API",
    version: "1.0.0",
  },
  paths: {
    "/api/v1/operator/taskbus": {
      get: {
        operationId: "getTaskBus",
        security: [{ operatorBearer: [] }, { sessionBearer: [] }],
        responses: {
          "200": { $ref: "#/components/responses/GetTaskBus" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
      put: {
        operationId: "putTaskBus",
        security: [{ operatorBearer: [] }, { sessionBearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PutTaskBusRequest" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/PutTaskBus" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "409": { $ref: "#/components/responses/EnvOverride" },
        },
      },
    },
    "/api/v1/operator/taskbus/ping": {
      post: {
        operationId: "pingTaskBus",
        security: [{ operatorBearer: [] }, { sessionBearer: [] }],
        responses: {
          "200": { $ref: "#/components/responses/PingTaskBusOk" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "422": { $ref: "#/components/responses/PingTaskBusUnreachable" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      operatorBearer: { type: "http", scheme: "bearer" },
      sessionBearer: { type: "http", scheme: "bearer" },
    },
    schemas: {
      TaskBusConfig: {
        type: "object",
        additionalProperties: false,
        required: ["backend", "source", "status"],
        properties: {
          backend: { enum: ["memory", "nats"] },
          nats_url: {
            oneOf: [
              { type: "string", pattern: "^(nats|tls)://" },
              { type: "null" },
            ],
          },
          source: { enum: ["env", "stored", "default"] },
          status: { type: "string", minLength: 1 },
          last_error: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      PutTaskBusRequest: {
        type: "object",
        additionalProperties: false,
        required: ["backend"],
        properties: {
          backend: { enum: ["memory", "nats"] },
          nats_url: { type: "string", pattern: "^(nats|tls)://" },
        },
      },
    },
    responses: {
      GetTaskBus: {
        description: "Current effective TaskBus config",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["taskbus"],
              properties: {
                taskbus: { $ref: "#/components/schemas/TaskBusConfig" },
              },
            },
          },
        },
      },
      PutTaskBus: {
        description: "Stored (and optionally applied) TaskBus config",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["taskbus"],
              properties: {
                taskbus: { $ref: "#/components/schemas/TaskBusConfig" },
                applied: { type: "boolean" },
                hint: { type: "string" },
              },
            },
          },
        },
      },
      PingTaskBusOk: {
        description: "Host reached TaskBus backend",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok", "taskbus"],
              properties: {
                ok: { const: true },
                taskbus: { $ref: "#/components/schemas/TaskBusConfig" },
              },
            },
          },
        },
      },
      PingTaskBusUnreachable: {
        description: "Host could not reach NATS",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok", "taskbus"],
              properties: {
                ok: { const: false },
                taskbus: { $ref: "#/components/schemas/TaskBusConfig" },
                hint: { type: "string" },
              },
            },
          },
        },
      },
      BadRequest: {
        description: "Invalid backend or nats_url",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: {
                error: { type: "string" },
                hint: { type: "string" },
              },
            },
          },
        },
      },
      EnvOverride: {
        description: "Process env overrides stored config",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: {
                error: { const: "env_override" },
                hint: { type: "string" },
              },
            },
          },
        },
      },
      Unauthorized: { description: "Missing/invalid credentials" },
      Forbidden: { description: "Caller cannot configure TaskBus" },
    },
  },
} as const;
