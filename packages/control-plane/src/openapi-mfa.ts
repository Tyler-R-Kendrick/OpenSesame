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

const encoded = {
  type: "string",
  minLength: 1,
  maxLength: 16384,
  pattern: "^[A-Za-z0-9+/_=-]+$",
} as const;

/** A fresh proof from one of the caller's own factors (ADR 0146). */
const proofSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "code"],
      properties: {
        kind: { type: "string", const: "totp" },
        code: { type: "string", pattern: "^\\d{6}$" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "credentialId",
        "clientDataJSON",
        "authenticatorData",
        "signature",
      ],
      properties: {
        kind: { type: "string", const: "passkey" },
        credentialId: encoded,
        clientDataJSON: encoded,
        authenticatorData: encoded,
        signature: encoded,
      },
    },
  ],
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
  "/v1/mfa/passkey/authentication-options": {
    post: {
      summary:
        "Issue a one-time WebAuthn challenge; with a purpose, a step-up challenge bound to this principal and one factor",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["purpose", "factorId"],
              properties: {
                purpose: { type: "string", const: "factor.remove" },
                factorId: factorSchema.properties.id,
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Challenge and request options" },
        "400": { description: "Unknown purpose or not a factor id" },
        "401": { description: "Authentication required" },
        "404": { description: "No such factor on the caller's account" },
      },
    },
  },
  "/v1/mfa/factors/{id}": {
    delete: {
      summary:
        "Remove one of the caller's own account factors, proved by a fresh step-up from one of them (ADR 0146)",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [factorId],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["proof"],
              properties: { proof: proofSchema },
            },
          },
        },
      },
      responses: {
        "200": { description: "Removed" },
        "400": { description: "Not a factor id, or a malformed proof" },
        "401": { description: "Authentication required" },
        "403": {
          description:
            "`step_up_required` (no proof) or `step_up_failed` (a proof that did not verify); never 401, so a client keeps its session",
        },
        "404": { description: "No such factor on the caller's account" },
        "429": { description: "Failure fence" },
      },
    },
  },
} as const;
