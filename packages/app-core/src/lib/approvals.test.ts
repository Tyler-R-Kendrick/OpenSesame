/**
 * The Pages binding of authorization requests: which transport each call
 * rides, and the inbox rows ported from
 * `apps/ceremonies/src/pages/Inbox.test.tsx`. The review itself is
 * ceremony-kit's and tested there (`approval-review.test.ts`).
 */
import { ApprovalError } from "@opensesame/ceremony-kit";
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalTransport,
  approvalReview,
  decideHostedRequest,
  hostedRequestRow,
  identityApprovalTransport,
  listHostedRequests,
} from "./approvals.js";
import { identitySeams } from "./identity.js";

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SIMPLE = {
  authReqId: "areq_simple",
  status: "pending",
  bindingMessage: "Read the staging changelog",
  requestDigest: "digest-simple-000000000001",
  authorizationDetails: [
    { type: "connector", actions: ["read"], locations: ["staging-docs"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
  approval: {
    riskClass: "low",
    requireTransactionBoundActivation: false,
    requireComparison: false,
    required: ["subject_kind:human"],
  },
};

const CEREMONIAL = {
  authReqId: "areq_hard",
  status: "pending",
  bindingMessage: "Rotate the production signing key",
  requestDigest: "digest-hard-0000000000001",
  authorizationDetails: [
    { type: "connector", actions: ["rotate"], locations: ["prod-signer"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
  approval: {
    riskClass: "critical",
    requireTransactionBoundActivation: true,
    requireComparison: true,
    required: ["phishing_resistance", "comparison"],
  },
};

function transport(
  answers: Response[],
  signedIn = true,
): ApprovalTransport & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (_path: string, _init: RequestInit) => {
    return answers.shift() ?? json({ error: "unexpected" }, 500);
  });
  return { fetch, signedIn: () => signedIn };
}

const SESSION = {
  principalId: "prn_1",
  accessToken: "at_secret",
  issuerOrigin: "https://id.example",
};

const original = { ...identitySeams };
afterEach(() => {
  Object.assign(identitySeams, original);
});

describe("identity transport", () => {
  it("rides identityFetch at a base-relative path, and knows the session", async () => {
    identitySeams.currentSession = () => SESSION;
    const identityFetch = vi.fn(async () => json({ requests: [SIMPLE] }));
    identitySeams.identityFetch = identityFetch;

    const inbox = await listHostedRequests();

    expect(identityApprovalTransport.signedIn()).toBe(true);
    expect(identityFetch).toHaveBeenCalledWith(
      "/v1/authorization-requests?status=pending",
      expect.objectContaining({ method: "GET" }),
    );
    // `identityFetch` attaches the bearer; the model never handles it.
    expect(JSON.stringify(identityFetch.mock.calls)).not.toContain("at_secret");
    expect(inbox.kind).toBe("rows");
  });

  it("binds a review to the same transport", async () => {
    const t = transport([json({ error: "request_not_pending" }, 422)]);
    const step = await approvalReview("areq_1", {
      transport: t,
      authenticator: { available: () => false, assert: vi.fn() },
    }).load();

    expect(t.fetch).toHaveBeenCalledWith(
      "/v1/authorization-requests/areq_1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(step?.phase.kind).toBe("done");
  });
});

describe("hosted inbox", () => {
  it("keeps the inline decision for a request that needs nothing extra", async () => {
    const t = transport([
      json({ requests: [SIMPLE] }),
      json({ ...SIMPLE, status: "approved" }),
    ]);

    const inbox = await listHostedRequests(t);
    if (inbox.kind !== "rows") throw new Error("expected rows");
    const [row] = inbox.rows;
    if (!row) throw new Error("expected a row");
    expect(row).toMatchObject({
      plane: "hosted",
      decide: "inline",
      details: ["read — staging-docs"],
      digestPrefix: "digest-simpl",
    });
    expect(row.summary).toMatch(/nothing extra/);

    await decideHostedRequest(row, "approve", t);
    // The digest echo is preserved exactly as it was shown.
    const [path, init] = t.fetch.mock.calls[1] ?? [];
    expect(path).toBe("/v1/authorization-requests/areq_simple/approve");
    expect(JSON.parse(String(init?.body))).toEqual({
      requestDigest: SIMPLE.requestDigest,
    });
  });

  it("routes a request that needs a ceremony through the review instead", async () => {
    const t = transport([json({ requests: [CEREMONIAL] })]);

    const inbox = await listHostedRequests(t);
    if (inbox.kind !== "rows") throw new Error("expected rows");
    const [row] = inbox.rows;
    if (!row) throw new Error("expected a row");

    // The summary says what will be asked for, before anything is opened.
    expect(row.summary).toBe(
      "Needs a passkey touch for this exact request and the six-digit code from where it started.",
    );
    expect(row.decide).toBe("review");
    expect(row.reviewPath).toBe("/approve/areq_hard");
    // No inline decision: this one cannot honestly be decided from a list.
    await expect(decideHostedRequest(row, "approve", t)).rejects.toBeInstanceOf(
      ApprovalError,
    );
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a row without a summary to the review, never inline", () => {
    const row = hostedRequestRow({
      authReqId: SIMPLE.authReqId,
      status: SIMPLE.status,
      bindingMessage: SIMPLE.bindingMessage,
      requestDigest: SIMPLE.requestDigest,
      authorizationDetails: SIMPLE.authorizationDetails,
      expiresAt: SIMPLE.expiresAt,
      assurance: null,
    });
    expect(row.decide).toBe("review");
    expect(row.summary).toMatch(/Open it to see/);
  });

  it("shows both kinds side by side without confusing them", async () => {
    const t = transport([json({ requests: [SIMPLE, CEREMONIAL] })]);
    const inbox = await listHostedRequests(t);
    if (inbox.kind !== "rows") throw new Error("expected rows");
    expect(inbox.rows.map((row) => row.decide)).toEqual(["inline", "review"]);
  });

  it("says a 409 changed since it was shown rather than swallowing it", async () => {
    const t = transport([
      json({ requests: [SIMPLE] }),
      json({ error: "digest_changed" }, 409),
    ]);
    const inbox = await listHostedRequests(t);
    if (inbox.kind !== "rows" || !inbox.rows[0]) throw new Error("rows");

    const refused = await decideHostedRequest(inbox.rows[0], "deny", t).catch(
      (error) => error,
    );

    expect(refused.message).toContain("changed since it was shown");
    expect(refused.message).toContain("nothing was decided");
  });

  it("asks for a sign-in rather than showing an empty inbox", async () => {
    const t = transport([], false);
    const inbox = await listHostedRequests(t);
    expect(inbox).toMatchObject({ kind: "signin" });
    if (inbox.kind === "signin") {
      expect(inbox.words).toMatch(/needs you signed in/);
    }
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("reads a refused session as a sign-in too", async () => {
    const t = transport([json({ error: "unauthorized" }, 401)]);
    expect((await listHostedRequests(t)).kind).toBe("signin");
  });
});
