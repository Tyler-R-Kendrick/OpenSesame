/** Schemas for the authorization-request inbox and the interaction layer. */
export const interactionSchemas = {
  AuthorizationRequestStatus: {
    type: "string",
    enum: ["pending", "approved", "denied", "expired", "cancelled"],
  },
  ApprovalDecidedByKind: { type: "string", enum: ["human", "agent"] },
  AuthorizationDetail: {
    type: "object",
    description:
      "One RFC 9396 authorization_details entry. Extension members are preserved verbatim, because the digest is computed over the whole object.",
    additionalProperties: true,
    required: ["type"],
    properties: {
      type: { type: "string", minLength: 1, maxLength: 128 },
      locations: { type: "array", items: { type: "string" } },
      actions: { type: "array", items: { type: "string" } },
      datatypes: { type: "array", items: { type: "string" } },
      identifier: { type: "string" },
      privileges: { type: "array", items: { type: "string" } },
    },
  },
  CreateAuthorizationRequest: {
    type: "object",
    additionalProperties: false,
    required: ["approverRef", "authorizationDetails", "bindingMessage"],
    properties: {
      approverRef: { type: "string", minLength: 8, maxLength: 256 },
      authorizationDetails: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: { $ref: "#/components/schemas/AuthorizationDetail" },
      },
      bindingMessage: { type: "string", minLength: 4, maxLength: 120 },
      connectionId: { type: "string" },
      delegationId: { type: "string" },
      ttlSeconds: {
        type: "integer",
        minimum: 30,
        maximum: 3600,
      },
    },
  },
  AuthorizationRequest: {
    type: "object",
    additionalProperties: false,
    required: [
      "authReqId",
      "status",
      "bindingMessage",
      "requestDigest",
      "authorizationDetails",
      "expiresAt",
      "intervalSeconds",
    ],
    properties: {
      authReqId: { type: "string" },
      status: {
        $ref: "#/components/schemas/AuthorizationRequestStatus",
      },
      bindingMessage: { type: "string" },
      requestDigest: {
        type: "string",
        description:
          "The canonical hash of exactly what is being consented to. An executor recomputes it before running anything.",
      },
      authorizationDetails: {
        type: "array",
        items: { $ref: "#/components/schemas/AuthorizationDetail" },
      },
      expiresAt: { type: "string", format: "date-time" },
      intervalSeconds: { type: "integer" },
      connectionId: { type: "string" },
      delegationId: { type: "string" },
      decidedAt: { type: "string", format: "date-time" },
      decidedByKind: {
        $ref: "#/components/schemas/ApprovalDecidedByKind",
      },
      requesterRef: {
        type: "string",
        description:
          "The opaque handle for whoever is asking (ADR 0084). Not a principal id.",
      },
      approval: {
        type: "object",
        additionalProperties: false,
        description:
          "What it will take to settle this request, summarised for a list. A projection of the effective policy, not the gate: settlement re-resolves the policy.",
        required: [
          "riskClass",
          "requireTransactionBoundActivation",
          "requireComparison",
          "required",
        ],
        properties: {
          riskClass: {
            type: "string",
            enum: ["low", "moderate", "high", "critical"],
          },
          requireTransactionBoundActivation: { type: "boolean" },
          requireComparison: { type: "boolean" },
          required: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  DecideAuthorizationRequest: {
    type: "object",
    additionalProperties: false,
    required: ["requestDigest"],
    properties: {
      requestDigest: { type: "string", minLength: 16 },
    },
  },
  InteractionKind: {
    type: "string",
    enum: [
      "device_authorization",
      "pairing",
      "claim",
      "grant_claim",
      "authorization_request",
      "transaction_authorization",
    ],
  },
  InteractionStatus: {
    type: "string",
    enum: [
      "pending",
      "presented",
      "awaiting_approval",
      "approved",
      "denied",
      "consumed",
      "expired",
      "revoked",
    ],
  },
  ApprovalMechanism: {
    type: "string",
    enum: ["webauthn", "openid4vp", "session_reauth", "out_of_band"],
  },
  InteractionErrorCode: {
    type: "string",
    enum: [
      "interaction_not_found",
      "interaction_expired",
      "interaction_revoked",
      "interaction_consumed",
      "interaction_settled",
      "interaction_already_live",
      "approval_required",
      "approval_denied",
      "proof_required",
      "digest_mismatch",
      "unsupported_kind",
      "invalid_request",
      "rate_limited",
    ],
  },
  InteractionError: {
    type: "object",
    required: ["error"],
    properties: {
      error: { $ref: "#/components/schemas/InteractionErrorCode" },
      fields: {
        type: "array",
        description: "Paths that failed validation. Never the values at them.",
        items: { type: "string" },
      },
      detail: { type: "string" },
    },
  },
  InteractionSubject: {
    type: "object",
    additionalProperties: false,
    description:
      "The ceremony this interaction fronts. Inbound only: subjectId never appears in a response, so a reference cannot be traded for the id of the row behind it.",
    required: ["kind", "subjectId"],
    properties: {
      kind: { $ref: "#/components/schemas/InteractionKind" },
      subjectId: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
  CreateInteraction: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "subject", "approverRef", "authorizationDetails"],
    properties: {
      kind: { $ref: "#/components/schemas/InteractionKind" },
      subject: { $ref: "#/components/schemas/InteractionSubject" },
      approverRef: {
        type: "string",
        minLength: 8,
        maxLength: 256,
        description:
          "The approver's inbox handle from GET /v1/authorization-requests/inbox-ref. Not a principal id.",
      },
      authorizationDetails: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: { $ref: "#/components/schemas/AuthorizationDetail" },
      },
      resourceRef: { type: "string", minLength: 1, maxLength: 512 },
      ttlSeconds: { type: "integer", minimum: 30, maximum: 3600 },
    },
  },
  InteractionCreated: {
    type: "object",
    additionalProperties: false,
    required: [
      "ref",
      "url",
      "requestDigest",
      "bindingMessage",
      "expiresAt",
      "status",
    ],
    properties: {
      ref: { type: "string" },
      url: {
        type: "string",
        format: "uri",
        description:
          "The canonical HTTPS short link, <publicUrl>/i/<ref>. Never a custom scheme.",
      },
      requestDigest: { type: "string" },
      bindingMessage: {
        type: "string",
        description:
          "Derived from the authorization details, never supplied by the requester.",
      },
      expiresAt: { type: "string", format: "date-time" },
      status: { $ref: "#/components/schemas/InteractionStatus" },
    },
  },
  InteractionSummary: {
    type: "object",
    additionalProperties: false,
    description:
      "Everything the holder of a bare reference may learn. No requester, no binding message, no digest, no authorization details, no subject id.",
    required: ["kind", "status", "expiresAt", "requiresApprover"],
    properties: {
      kind: { $ref: "#/components/schemas/InteractionKind" },
      status: { $ref: "#/components/schemas/InteractionStatus" },
      expiresAt: { type: "string", format: "date-time" },
      requiresApprover: { type: "boolean" },
    },
  },
  InteractionDetail: {
    type: "object",
    additionalProperties: false,
    description:
      "The authenticated approver's view. The approval proof and the fronted ceremony's subjectId are absent by construction.",
    required: [
      "kind",
      "status",
      "expiresAt",
      "requiresApprover",
      "id",
      "authorizationDetails",
      "createdAt",
    ],
    properties: {
      kind: { $ref: "#/components/schemas/InteractionKind" },
      status: { $ref: "#/components/schemas/InteractionStatus" },
      expiresAt: { type: "string", format: "date-time" },
      requiresApprover: { type: "boolean" },
      id: { type: "string" },
      requesterRef: { type: "string" },
      bindingMessage: { type: "string" },
      requestDigest: { type: "string" },
      authorizationDetails: {
        type: "array",
        items: { $ref: "#/components/schemas/AuthorizationDetail" },
      },
      resourceRef: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      decidedAt: { type: "string", format: "date-time" },
    },
  },
  ApprovalProof: {
    type: "object",
    additionalProperties: false,
    description:
      "The verified approval, reduced: no assertion bytes, no verifiable presentation, no JOSE. verifiedAt is absent because the server stamps it.",
    required: ["mechanism", "boundDigest", "assurance"],
    properties: {
      mechanism: { $ref: "#/components/schemas/ApprovalMechanism" },
      boundDigest: { type: "string", minLength: 16, maxLength: 256 },
      credentialRef: { type: "string", minLength: 1, maxLength: 256 },
      assurance: { $ref: "#/components/schemas/AssuranceLevel" },
    },
  },
  AssuranceLevel: {
    type: "string",
    enum: [
      "provisional",
      "self_asserted",
      "verified",
      "mfa",
      "phishing_resistant",
      "enterprise_managed",
      "workload_attested",
    ],
  },
  ApproveInteraction: {
    type: "object",
    additionalProperties: false,
    required: ["requestDigest"],
    properties: {
      requestDigest: { type: "string", minLength: 16, maxLength: 256 },
      // The handle of a ceremony verified at /activation/complete. Not a
      // proof: the server rebuilds the ApprovalProof from the spent
      // activation. Absent it, approve answers 401 proof_required (F01).
      activationId: { type: "string", minLength: 8, maxLength: 256 },
    },
  },
  BeginApprovalActivation: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "requestDigest"],
    properties: {
      decision: { type: "string", enum: ["approved", "denied"] },
      requestDigest: { type: "string", minLength: 16, maxLength: 256 },
    },
  },
  CompleteApprovalActivation: {
    type: "object",
    additionalProperties: false,
    required: [
      "activationId",
      "credentialId",
      "clientDataJSON",
      "authenticatorData",
      "signature",
    ],
    properties: {
      activationId: { type: "string", minLength: 8, maxLength: 256 },
      credentialId: { type: "string", minLength: 1, maxLength: 16384 },
      clientDataJSON: { type: "string", minLength: 1, maxLength: 16384 },
      authenticatorData: {
        type: "string",
        minLength: 1,
        maxLength: 16384,
      },
      signature: { type: "string", minLength: 1, maxLength: 16384 },
    },
  },
  DenyInteraction: {
    type: "object",
    additionalProperties: false,
    required: ["requestDigest"],
    properties: {
      requestDigest: { type: "string", minLength: 16, maxLength: 256 },
    },
  },
} as const;
