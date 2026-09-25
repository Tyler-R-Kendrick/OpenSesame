/**
 * The approval ceremonies' half of the stand-in Identity API (`/i/:ref`,
 * `/approve/:ref`, Access › Requests' hosted rows; ADR 0140 plan step 9),
 * and the `passkey` verb that gives a capture a virtual WebAuthn
 * authenticator holding one discoverable credential for the page's origin —
 * the same CDP `WebAuthn.addVirtualAuthenticator` `verify:local-iam` uses.
 *
 * The stand-in binds an activation the way the authority does (ADR 0084 §5):
 * it records the request digest, the verb and the policy digest each one was
 * minted under, and refuses a settle that names another. One request,
 * `areq_evidence_policy`, answers its activation under a policy other than
 * the one its requirement showed, so a journey can capture the review
 * refusing it before the passkey is asked for.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";

export const EVIDENCE_REF = "i_EvIdEnCeAbCdEfGhIjKl.0123456789abcdef";
const DIGEST = "v2:5d41402abc4b2a76b9719d911017c592";
const POLICY = "v1:policy-as-shown";

const REQUESTS = {
  areq_evidence_approve: {
    bindingMessage: "Deploy the billing service",
    details: [
      { type: "connector", actions: ["deploy"], locations: ["prod-billing"] },
    ],
  },
  areq_evidence_deny: {
    bindingMessage: "Export the audit log",
    details: [
      { type: "connector", actions: ["export"], locations: ["audit-log"] },
    ],
  },
  areq_evidence_policy: {
    bindingMessage: "Rotate the signing key",
    details: [
      { type: "connector", actions: ["rotate"], locations: ["signing-key"] },
    ],
  },
};

function bodyOf(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

/** One page's approval state: statuses and the activations it minted. */
export function approvalState() {
  return {
    interaction: "pending",
    requests: Object.fromEntries(
      Object.keys(REQUESTS).map((id) => [id, "pending"]),
    ),
    activations: new Map(),
    minted: 0,
  };
}

function interactionBody(status) {
  return {
    kind: "authorization_request",
    status,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    requiresApprover: true,
    id: "int_evidence",
    createdAt: new Date().toISOString(),
    requesterRef: "inbox_9f2",
    resourceRef: "acme/billing",
    bindingMessage: "Match 42",
    requestDigest: DIGEST,
    authorizationDetails: [],
  };
}

function requestBody(id, status) {
  const request = REQUESTS[id];
  return {
    authReqId: id,
    status,
    bindingMessage: request.bindingMessage,
    requestDigest: `${DIGEST}:${id}`,
    authorizationDetails: request.details,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    requesterRef: "req_opaque_7f3",
    requesterKind: "agent",
    approval: {
      riskClass: "high",
      requireTransactionBoundActivation: true,
      requireComparison: true,
      required: [
        "phishing_resistance",
        "transaction_bound_activation",
        "comparison",
      ],
    },
  };
}

function mint(state, digest, decision, policy, rpId) {
  const activationId = `act_${++state.minted}`;
  state.activations.set(activationId, { digest, decision, policy });
  return [
    201,
    {
      activationId,
      transactionDigest: `tx:${activationId}`,
      policyDigest: policy,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      options: {
        challenge: randomBytes(32).toString("base64url"),
        rpId,
        userVerification: "required",
        timeout: 60_000,
      },
    },
  ];
}

/** The settle check: this request, this verb, this policy — once. */
function spent(state, body, digest, decision, policy) {
  const activation = state.activations.get(body.activationId);
  state.activations.delete(body.activationId);
  if (body.requestDigest !== digest) return "digest_mismatch";
  if (!activation) return "activation_not_found";
  if (activation.digest !== digest) return "digest_mismatch";
  if (activation.decision !== decision) return "activation_wrong_decision";
  if (activation.policy !== policy) return "activation_policy_changed";
  return null;
}

function answerInteraction(state, at, body, rpId) {
  const api = `/v1/interactions/${EVIDENCE_REF}`;
  if (at === `GET /i/${EVIDENCE_REF}` || at === `GET ${api}`) {
    return [200, interactionBody(state.interaction)];
  }
  if (at === `POST ${api}/activation`) {
    return mint(state, body.requestDigest, body.decision, POLICY, rpId);
  }
  if (at === `POST ${api}/activation/complete`) {
    return [200, { activationId: body.activationId, state: "activated" }];
  }
  for (const [verb, decision] of [
    ["approve", "approved"],
    ["deny", "denied"],
  ]) {
    if (at !== `POST ${api}/${verb}`) continue;
    const refused =
      verb === "deny"
        ? body.requestDigest === DIGEST
          ? null
          : "digest_mismatch"
        : spent(state, body, DIGEST, decision, POLICY);
    // The interaction route answers an unusable activation `proof_required`.
    if (refused === "digest_mismatch") return [409, { error: refused }];
    if (refused) return [401, { error: "proof_required" }];
    state.interaction = decision;
    return [200, interactionBody(decision)];
  }
  return null;
}

function answerRequest(state, at, body, rpId) {
  if (at === "GET /v1/authorization-requests?status=pending") {
    const pending = Object.entries(state.requests)
      .filter(([, status]) => status === "pending")
      .map(([id]) => requestBody(id, "pending"));
    return [200, { requests: pending }];
  }
  const match =
    /^(GET|POST) \/v1\/authorization-requests\/([\w-]+)(\/[\w/]+)?$/.exec(at);
  if (!match || !(match[2] in REQUESTS)) return null;
  const [, , id, tail = ""] = match;
  const digest = `${DIGEST}:${id}`;
  // The requirement shows POLICY; one request mints under another.
  const minted = id === "areq_evidence_policy" ? "v1:policy-tightened" : POLICY;
  if (tail === "") return [200, requestBody(id, state.requests[id])];
  if (tail === "/requirement") {
    return [
      200,
      {
        ...requestBody(id, "pending").approval,
        policyDigest: POLICY,
        maximumApprovalAgeSeconds: 120,
        arrivedVia: "telegram",
      },
    ];
  }
  if (tail === "/activation") {
    return mint(state, body.requestDigest, body.decision, minted, rpId);
  }
  if (tail === "/activation/complete") {
    return [200, { activationId: body.activationId, state: "activated" }];
  }
  if (tail === "/report") {
    state.requests[id] = "denied";
    return [200, requestBody(id, "denied")];
  }
  const decision = { "/approve": "approved", "/deny": "denied" }[tail];
  if (!decision) return null;
  if (body.comparisonValue !== "424242") {
    return [409, { error: "comparison_mismatch" }];
  }
  const refused = spent(state, body, digest, decision, POLICY);
  if (refused) return [409, { error: refused }];
  state.requests[id] = decision;
  return [200, requestBody(id, decision)];
}

/**
 * Answer an approval route at `at` (`METHOD /path?query`), or `null`. The
 * relying party id is the Pages origin's host, so the virtual credential
 * `passkey` adds answers the options.
 */
export function answerApprovals(state, at, request, pagesOrigin) {
  const body = bodyOf(request);
  const rpId = new URL(pagesOrigin).hostname;
  return (
    answerInteraction(state, at, body, rpId) ??
    answerRequest(state, at, body, rpId)
  );
}

/** A P-256 key as the PKCS#8 DER `WebAuthn.addCredential` takes, base64. */
function credentialFor(rpId) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentialId: randomBytes(16).toString("base64"),
    isResidentCredential: true,
    rpId,
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    userHandle: Buffer.from("evidence-approver").toString("base64"),
    signCount: 0,
  };
}

export function approvalSteps() {
  return {
    /**
     * Give this page a virtual platform authenticator (ctap2, internal,
     * user-verifying, presence simulated) holding one discoverable P-256
     * credential for the page's origin.
     */
    async passkey(page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );
      const rpId = new URL(page.url()).hostname;
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: credentialFor(rpId),
      });
      console.log(`  passkey: virtual authenticator for ${rpId}`);
    },
    /** Print what each status mark on the page says (its accessible name). */
    async marks(page) {
      const labels = await page
        .locator("main .status-mark")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label")),
        );
      console.log(`  marks: ${labels.join(" | ") || "none"}`);
    },
    /** Tick the checkbox whose label starts with these words, when present. */
    async confirmOptional(page, words) {
      const box = page.getByRole("checkbox", { name: new RegExp(`^${words}`) });
      if (!(await box.count()) || !(await box.first().isEnabled())) return;
      await box.first().check();
      await page.waitForTimeout(300);
    },
  };
}
