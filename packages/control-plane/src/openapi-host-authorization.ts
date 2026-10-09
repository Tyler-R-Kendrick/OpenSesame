const challengeProperties = {
  challenge_id: { type: "string", maxLength: 128 },
  challenge_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
  host_audience: { type: "string", format: "uri" },
  organization_id: { type: "string", maxLength: 128 },
  operation: { enum: ["browser.authenticate", "agent.browser.control"] },
  transition: { enum: [null, "handoff", "take", "release"] },
  target_id: { type: "string", maxLength: 128 },
  origin: { type: "string", format: "uri" },
  dpop_jkt: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  expires_at: {
    type: "integer",
    description: "Unix seconds, future and at most five minutes away",
  },
};
const responses = {
  "200": { description: "Bound WebAuthn options or verified signed assertion" },
  "400": { description: "Invalid closed request envelope" },
  "401": { description: "Validated Identity session required" },
  "403": { description: "Authorization or real user verification refused" },
  "404": { description: "Host authorization is not configured" },
};
export const hostAuthorizationPaths = {
  "/v1/host-authorizations/ceremony": {
    get: {
      summary:
        "Open Identity-origin passkey verification for an explicitly allowed requesting origin",
      parameters: [
        {
          name: "origin",
          in: "query",
          required: true,
          schema: { type: "string", format: "uri" },
        },
        {
          name: "state",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{43}$" },
        },
      ],
      responses: {
        "200": { description: "Non-framable Identity-origin ceremony HTML" },
        "403": {
          description: "Origin, state or configured Host audience refused",
        },
      },
    },
  },
  "/v1/host-authorizations/ceremony.js": {
    get: {
      summary: "Same-origin ceremony script",
      responses: {
        "200": { description: "JavaScript; no credential material" },
      },
    },
  },
  "/v1/host-authorizations/ceremony.css": {
    get: {
      summary: "Shared hosted ceremony styling",
      responses: { "200": { description: "Stylesheet" } },
    },
  },
  "/v1/host-authorizations/options": {
    post: {
      summary: "Begin an exact Host transaction passkey ceremony",
      description:
        "Requires explicit Host audience configuration and current organization membership. Browser authentication requires null transition; browser control requires a named transition. Display the returned frozen challenge before user verification.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: Object.keys(challengeProperties),
              properties: challengeProperties,
            },
          },
        },
      },
      responses,
    },
  },
  "/v1/host-authorizations/verify": {
    post: {
      summary:
        "Verify real user-presence and user-verification WebAuthn evidence",
      description:
        "Consumes the pending transaction atomically, rechecks membership, and returns a RS256 host-authorization+jwt assertion bound to the frozen Host challenge. No caller assurance, time or role claims are accepted.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "authorization_id",
                "credentialId",
                "clientDataJSON",
                "authenticatorData",
                "signature",
              ],
              properties: {
                authorization_id: { type: "string", format: "uuid" },
                credentialId: { type: "string", maxLength: 16384 },
                clientDataJSON: { type: "string", maxLength: 16384 },
                authenticatorData: { type: "string", maxLength: 16384 },
                signature: { type: "string", maxLength: 16384 },
              },
            },
          },
        },
      },
      responses,
    },
  },
};
