/**
 * `/v1/mfa/*` paths. The factor listing is display-safe by contract (ADR 0140
 * D10): the schema is closed, and names no key, seed or counter.
 */

const factorKind = { type: "string", enum: ["passkey", "totp"] } as const;

const factorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind"],
  properties: {
    id: {
      type: "string",
      pattern: "^(?:totp|pk_[0-9a-f]{32})$",
      description:
        "Opaque handle: `totp`, or `pk_` and 32 hex digits of the credential id's SHA-256",
    },
    kind: factorKind,
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const factorId = {
  name: "id",
  in: "path",
  required: true,
  schema: factorSchema.properties.id,
} as const;

export const mfaPaths = {
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
  "/v1/mfa/factors": {
    get: {
      summary:
        "List the caller's own account factors (never a public key, seed or counter)",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": {
          description: "The caller's factors, and the kinds it may add",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["ok", "factors", "enrollable"],
                properties: {
                  ok: { type: "boolean", const: true },
                  factors: { type: "array", items: factorSchema },
                  enrollable: { type: "array", items: factorKind },
                },
              },
            },
          },
        },
        "401": { description: "Authentication required" },
      },
    },
  },
  "/v1/mfa/factors/{id}": {
    delete: {
      summary: "Remove one of the caller's own account factors",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [factorId],
      responses: {
        "200": { description: "Removed" },
        "400": { description: "Not a factor id" },
        "401": { description: "Authentication required" },
        "404": { description: "No such factor on the caller's account" },
      },
    },
  },
} as const;
