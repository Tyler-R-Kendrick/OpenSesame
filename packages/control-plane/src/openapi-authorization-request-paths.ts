const authenticationUnauthorizedResponse = {
  "401": { description: "Authentication required" },
} as const;

/** The authorization-request inbox and its requester routes (ADR 0046). */
export const authorizationRequestPaths = {
  "/v1/authorization-requests": {
    get: {
      summary: "The caller's own authorization-request inbox",
      description:
        "Only ever the caller's own requests; there is no route that lists somebody else's.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            $ref: "#/components/schemas/AuthorizationRequestStatus",
          },
        },
      ],
      responses: {
        "200": {
          description: "Authorization requests awaiting or settled",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["requests"],
                properties: {
                  requests: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/AuthorizationRequest",
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
      summary: "Ask a principal to authorize something",
      description:
        "Addressed by the approver's inbox handle, never by a principal id: an unverifiable handle and a handle for a principal that must not be asked both answer 404, so nothing here confirms that an id exists. Honours Idempotency-Key.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/CreateAuthorizationRequest",
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Request created and waiting",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AuthorizationRequest",
              },
            },
          },
        },
        "400": { description: "invalid_request" },
        "401": { description: "Unauthorized" },
        "404": {
          description:
            "not_found: the approver handle does not verify, or names a principal that must not be asked",
        },
      },
    },
  },
  "/v1/authorization-requests/inbox-ref": {
    get: {
      summary: "The caller's own inbox handle, to share with whoever may ask",
      description:
        "The only place a handle comes from, so a caller can never obtain somebody else's.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": {
          description: "Inbox handle",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["approverRef"],
                properties: { approverRef: { type: "string" } },
              },
            },
          },
        },
        "401": { description: "Unauthorized" },
      },
    },
  },
  "/v1/authorization-requests/{id}": {
    get: {
      summary: "Read one authorization request",
      description:
        "Readable by its approver and by its requester. Anyone else gets 404 rather than 403, so the id space is not enumerable.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Authorization request",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AuthorizationRequest",
              },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "404": { description: "not_found" },
      },
    },
  },
  "/v1/authorization-requests/{id}/poll": {
    get: {
      summary: "Poll for an answer, paced like a device flow",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Current state",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AuthorizationRequest",
              },
            },
          },
        },
        "400": {
          description: "slow_down: polled faster than the given interval",
        },
        "401": { description: "Unauthorized" },
        "404": { description: "not_found" },
        "410": { description: "expired_request" },
      },
    },
  },
  "/v1/authorization-requests/{id}/approve": {
    post: {
      summary: "Approve, echoing the digest that was displayed",
      description:
        "Only the approver may decide, and only with the stored requestDigest: a request that changed between being shown and being approved is refused rather than silently consented to.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
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
              $ref: "#/components/schemas/DecideAuthorizationRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Settled",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AuthorizationRequest",
              },
            },
          },
        },
        "400": { description: "invalid_request" },
        "401": { description: "Unauthorized" },
        "404": { description: "not_found" },
        "409": { description: "digest_mismatch, or conflict" },
        "410": { description: "expired" },
        "422": { description: "invalid_transition" },
      },
    },
  },
  "/v1/authorization-requests/{id}/deny": {
    post: {
      summary: "Refuse, echoing the digest that was displayed",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
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
              $ref: "#/components/schemas/DecideAuthorizationRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Settled",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AuthorizationRequest",
              },
            },
          },
        },
        "400": { description: "invalid_request" },
        "401": { description: "Unauthorized" },
        "404": { description: "not_found" },
        "409": { description: "digest_mismatch, or conflict" },
        "410": { description: "expired" },
        "422": { description: "invalid_transition" },
      },
    },
  },
  "/v1/authorization-requests/{id}/cancel": {
    post: {
      summary: "The requester withdraws a request nobody has answered",
      description:
        "Requester only (ADR 0159): the approver has /deny, which records a decision, and a withdrawal records none. Everyone else, the approver included, gets the same 404 as an id that never existed. Idempotent: withdrawing a request already withdrawn answers its current state. A request that already has another ending keeps it (409 request_not_pending, 410 expired_request). Also closes the interaction fronting the request, if one is live, so nothing stays approvable for a question that no longer exists.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Withdrawn, or already withdrawn",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AuthorizationRequest",
              },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "404": { description: "not_found" },
        "409": { description: "request_not_pending, or conflict" },
        "410": { description: "expired_request" },
      },
    },
  },
  "/v1/authorization-requests/{id}/requirement": {
    get: {
      summary: "What this request will take to settle (ADR 0084)",
      description:
        "Reason codes and policy digest, so an approval screen can say why an authenticator is being asked for. Approver only; anyone else gets 404.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": { description: "Approval requirement" },
        "404": { description: "Not the caller's request" },
        ...authenticationUnauthorizedResponse,
      },
    },
  },
  "/v1/authorization-requests/{id}/activation": {
    post: {
      summary: "Mint a WebAuthn ceremony bound to one approval transaction",
      description:
        "The challenge is bound to a digest over the request, the decision and the effective policy, so it cannot be spent on another request, the other decision, or under a policy that has since been tightened.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "201": { description: "Activation and request options" },
        "409": { description: "The request changed since it was shown" },
        "422": { description: "The request is no longer pending" },
        ...authenticationUnauthorizedResponse,
      },
    },
  },
  "/v1/authorization-requests/{id}/activation/complete": {
    post: {
      summary: "Verify the assertion and activate the ceremony",
      description:
        "Verification only: the activation is spent by the settlement that follows, as a compare-and-set on the stored row.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": { description: "Activated" },
        // The assertion, the challenge binding and an absent session all
        // answer 401: which one it was is not the caller's to learn.
        "401": { description: "Assertion or challenge binding refused" },
        "404": { description: "No such activation for this caller" },
        "410": { description: "Activation expired" },
      },
    },
  },
  "/v1/authorization-requests/{id}/comparison": {
    get: {
      summary: "Issue the comparison value to the requesting surface",
      description:
        "Server-generated, returned exactly once, stored only as a digest, and never sent to the approver or to any notification body.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": { description: "The six-digit value" },
        "409": { description: "Already issued, or the request is settled" },
        "404": { description: "Not the caller's request" },
        ...authenticationUnauthorizedResponse,
      },
    },
  },
  "/v1/authorization-requests/{id}/report": {
    post: {
      summary: "Report a prompt the approver does not recognize",
      description:
        "Refuses the request and raises a security event. Grants nothing, and deliberately publishes no notification: a report must not become an amplifier.",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": { description: "Refused" },
        "409": { description: "Digest mismatch" },
        "404": { description: "Not the caller's request" },
        ...authenticationUnauthorizedResponse,
      },
    },
  },
  "/v1/authorization-requests/{id}/receipt": {
    get: {
      summary: "The approval receipt: required vs achieved assurance",
      security: [{ bearerAuth: [] }, { provisionalCookie: [] }],
      responses: {
        "200": { description: "Receipt" },
        "404": { description: "No receipt the caller may read" },
        ...authenticationUnauthorizedResponse,
      },
    },
  },
} as const;
