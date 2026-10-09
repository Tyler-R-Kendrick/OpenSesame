const authenticationUnauthorizedResponse = {
  "401": { description: "Authentication required" },
} as const;

/** The cross-device interaction layer (ADR 0086). */
export const interactionPaths = {
  "/i/{ref}": {
    get: {
      summary: "Resolve an interaction reference (ADR 0086 canonical link)",
      description:
        "Unauthenticated: a camera, a wallet pass and a pasted link all arrive with nothing. Answers an InteractionSummary and records that somebody looked; scanning is never approving. A malformed reference, a forged MAC and an id that never existed are one 404 at one cost. Negotiates on Accept: application/json returns the summary, anything else returns a minimal HTML landing page.",
      parameters: [
        {
          name: "ref",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Interaction summary, or the HTML landing page",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionSummary" },
            },
            "text/html": { schema: { type: "string" } },
          },
        },
        "404": {
          description: "interaction_not_found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionError" },
            },
          },
        },
        "410": { description: "interaction_expired" },
        "429": { description: "rate_limited" },
      },
    },
  },
  "/v1/interactions": {
    get: {
      summary: "The approver's interaction inbox",
      description:
        "A survey, not a presentation: listing does not move anything to awaiting_approval.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: { $ref: "#/components/schemas/InteractionStatus" },
        },
      ],
      responses: {
        "200": {
          description: "Interactions awaiting this approver",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["interactions"],
                properties: {
                  interactions: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/InteractionDetail",
                    },
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
      summary: "Raise a cross-device interaction over a ceremony",
      description:
        "The server derives the binding message from the authorization details and computes the request digest over both; neither is taken from the body. Honours Idempotency-Key. Cookie-authenticated browser mutations also require an allowed Origin header.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateInteraction" },
          },
        },
      },
      responses: {
        "201": {
          description: "Interaction created; the reference is safe to print",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionCreated" },
            },
          },
        },
        "400": { description: "invalid_request" },
        "401": { description: "Unauthorized" },
        "404": {
          description:
            "interaction_not_found: the approver handle does not verify, or names a principal that must not be asked",
        },
        "409": {
          description:
            "interaction_already_live: one live interaction per ceremony",
        },
        "422": {
          description:
            "unsupported_kind, or an authorization detail that carries card data",
        },
      },
    },
  },
  "/v1/interactions/{ref}": {
    get: {
      summary: "Open the question as its approver",
      description:
        "The approver only; anyone else gets 404. Moves the interaction to awaiting_approval and records the approver. The fronted ceremony's subjectId is never returned.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Interaction detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionDetail" },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "404": { description: "interaction_not_found" },
        "410": { description: "interaction_expired" },
      },
    },
  },
  "/v1/interactions/{ref}/approve": {
    post: {
      summary: "Approve, spending an interaction-scoped activation",
      description:
        "The body echoes requestDigest and names an activationId — the handle of a WebAuthn ceremony already verified at /activation/complete. The server rebuilds the ApprovalProof from that spent activation (mechanism, boundDigest, assurance, verifiedAt from the server clock); it never trusts a client-constructed proof. Both the echoed requestDigest and the proof's server-derived boundDigest must equal the stored digest. An approve carrying only requestDigest, with no spent activation, answers 401 proof_required: an ordinary session may deny, but may not approve a privileged interaction.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApproveInteraction" },
          },
        },
      },
      responses: {
        "200": {
          description: "Approved",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionDetail" },
            },
          },
        },
        "400": { description: "invalid_request" },
        "401": {
          description:
            "Unauthorized, or proof_required when no spent activation is presented",
        },
        "404": { description: "interaction_not_found" },
        "409": {
          description:
            "digest_mismatch, interaction_settled, interaction_revoked, or interaction_consumed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionError" },
            },
          },
        },
        "410": { description: "interaction_expired" },
      },
    },
  },
  "/v1/interactions/{ref}/deny": {
    post: {
      summary: "Refuse, echoing the displayed digest",
      description:
        "No proof is required — refusing only ever removes authority — but the echo still has to name this request, so a stale tab cannot deny the request that replaced it.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DenyInteraction" },
          },
        },
      },
      responses: {
        "200": {
          description: "Denied",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionDetail" },
            },
          },
        },
        "400": { description: "invalid_request" },
        "401": { description: "Unauthorized" },
        "404": { description: "interaction_not_found" },
        "409": {
          description:
            "digest_mismatch, interaction_settled, interaction_revoked, or interaction_consumed",
        },
        "410": { description: "interaction_expired" },
      },
    },
  },
  "/v1/interactions/{ref}/activation": {
    post: {
      summary: "Mint a WebAuthn ceremony bound to this interaction approval",
      description:
        "Interaction-scoped step-up (A-01). The challenge is bound to a digest over the interaction, the approve decision and the effective policy, so it cannot be spent on another interaction, on a deny, or under a policy since tightened. Only decision=approved mints an activation. Returns the activation handle and the request options; the raw assertion is completed at /activation/complete and never travels through /approve.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
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
              $ref: "#/components/schemas/BeginApprovalActivation",
            },
          },
        },
      },
      responses: {
        "201": { description: "Activation and request options" },
        "400": {
          description: "invalid_request (including a deny decision)",
        },
        "404": { description: "interaction_not_found" },
        "409": { description: "digest_mismatch" },
        "410": { description: "interaction_expired" },
        "422": { description: "interaction_settled" },
        ...authenticationUnauthorizedResponse,
      },
    },
  },
  "/v1/interactions/{ref}/activation/complete": {
    post: {
      summary: "Verify the assertion and activate the interaction ceremony",
      description:
        "Verification only (A-02): the raw WebAuthn assertion is checked by the real phishing-resistant verifier (ADR 0084), and the activation is spent by the subsequent /approve as a compare-and-set on the stored row. A missing enrolment or a revoked credential fails verification here (A-05), never at /approve.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
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
              $ref: "#/components/schemas/CompleteApprovalActivation",
            },
          },
        },
      },
      responses: {
        "200": { description: "Activated" },
        // The assertion, the challenge binding and an absent session all
        // answer 401: which one it was is not the caller's to learn.
        "401": { description: "Assertion or challenge binding refused" },
        "404": { description: "No such activation for this caller" },
        "409": { description: "activation_not_pending" },
        "410": { description: "activation_expired" },
      },
    },
  },
  "/v1/interactions/{ref}/consume": {
    post: {
      summary: "Spend the approval, exactly once",
      description:
        "The requester's route. A compare-and-set on the row version serializes two executors racing to spend one approval; the loser gets 409. Spending an interaction nobody has answered yet answers 401 approval_required — the caller is authenticated and is the right caller, and what is missing is the ceremony. Spending one a person refused answers 403 approval_denied, which is final: the requester should stop waiting.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Consumed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionDetail" },
            },
          },
        },
        "401": {
          description: "Unauthorized, or approval_required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionError" },
            },
          },
        },
        "403": {
          description: "approval_denied: a person refused; final",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionError" },
            },
          },
        },
        "404": { description: "interaction_not_found" },
        "409": {
          description: "interaction_consumed, or interaction_revoked",
        },
        "410": { description: "interaction_expired" },
      },
    },
  },
  "/v1/interactions/{ref}/revoke": {
    post: {
      summary: "Withdraw an interaction",
      description:
        "Either the approver or the requester, and available from approved too: between approving and executing there is a window, and a user who reconsiders inside it must be able to close it.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "ref",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Revoked",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InteractionDetail" },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "404": { description: "interaction_not_found" },
        "409": {
          description:
            "interaction_consumed, interaction_revoked, or interaction_settled",
        },
        "410": { description: "interaction_expired" },
      },
    },
  },
} as const;
