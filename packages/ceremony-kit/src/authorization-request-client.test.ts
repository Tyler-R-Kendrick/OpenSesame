import { describe, expect, it, vi } from "vitest";
import { json } from "./approval-review.fixture.js";
import { ApprovalError } from "./approval-words.js";
import {
  createAuthorizationRequestClient,
  readAuthorizationRequest,
} from "./authorization-request-client.js";

const ROW = {
  authReqId: "areq_hard",
  status: "pending",
  bindingMessage: "Rotate the production signing key",
  requestDigest: "digest-hard-0000000000001",
  authorizationDetails: [
    { type: "connector", actions: ["rotate"], locations: ["prod-signer"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
  intervalSeconds: 5,
};

describe("readAuthorizationRequest", () => {
  it("reads the server's nested approval summary", () => {
    const view = readAuthorizationRequest({
      ...ROW,
      approval: {
        riskClass: "critical",
        requireTransactionBoundActivation: true,
        requireComparison: true,
        required: ["phishing_resistance", "comparison"],
      },
    });
    expect(view?.assurance).toEqual({
      riskClass: "critical",
      requireTransactionBoundActivation: true,
      requireComparison: true,
      required: ["phishing_resistance", "comparison"],
    });
  });

  it("reads the older top-level summary", () => {
    const view = readAuthorizationRequest({
      ...ROW,
      requireTransactionBoundActivation: true,
      requireComparison: false,
      requiredAssurance: ["phishing_resistance"],
    });
    expect(view?.assurance).toMatchObject({
      requireTransactionBoundActivation: true,
      required: ["phishing_resistance"],
    });
  });

  it("says a row without a summary has none, rather than needing nothing", () => {
    expect(readAuthorizationRequest(ROW)?.assurance).toBeNull();
  });

  it("keeps only the fields it names", () => {
    const view = readAuthorizationRequest({
      ...ROW,
      providerSubjectId: "U0FAKESUBJECT",
      accessToken: "osc_at_leaked",
      authorizationDetails: [
        { type: "connector", actions: ["rotate", 7], secret: "s3cr3t" },
        "not a detail",
      ],
    });
    const seen = JSON.stringify(view);
    expect(seen).not.toMatch(/U0FAKESUBJECT|osc_at_leaked|s3cr3t/);
    expect(view?.authorizationDetails).toEqual([
      { type: "connector", actions: ["rotate"] },
    ]);
  });

  it("refuses a row with no id or no digest", () => {
    expect(readAuthorizationRequest({ ...ROW, requestDigest: 1 })).toBeNull();
    expect(readAuthorizationRequest("areq_1")).toBeNull();
  });
});

describe("createAuthorizationRequestClient", () => {
  it("lists pending requests through the injected fetch, JSON both ways", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ requests: [ROW, { junk: true }] }),
    );
    const client = createAuthorizationRequestClient({ fetchImpl });

    const rows = await client.listPending();

    expect(rows.map((row) => row.authReqId)).toEqual(["areq_hard"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/authorization-requests?status=pending",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ accept: "application/json" }),
      }),
    );
  });

  it("escapes a request id into one path segment", async () => {
    const fetchImpl = vi.fn(async (_path: string, _init: RequestInit) =>
      json(ROW),
    );
    const client = createAuthorizationRequestClient({ fetchImpl });

    await client.read("a/b?c");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "/v1/authorization-requests/a%2Fb%3Fc",
    );
  });

  it("throws a worded refusal keyed on the body's code", async () => {
    const client = createAuthorizationRequestClient({
      fetchImpl: async () => json({ error: "digest_mismatch" }, 409),
    });

    const refused = await client.read("areq_1").catch((error) => error);

    expect(refused).toBeInstanceOf(ApprovalError);
    expect(refused).toMatchObject({
      kind: "changed",
      ends: true,
      status: 409,
      declared: "digest_mismatch",
    });
  });

  it("says unreachable when nothing reached the server", async () => {
    const client = createAuthorizationRequestClient({
      fetchImpl: async () => {
        throw new TypeError("offline");
      },
    });

    await expect(client.listPending()).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("refuses a requirement or a challenge it cannot read", async () => {
    const client = createAuthorizationRequestClient({
      fetchImpl: async () => json({ riskClass: "high" }),
    });

    await expect(client.requirement("areq_1")).rejects.toMatchObject({
      kind: "failed",
    });
    await expect(
      client.beginActivation("areq_1", "approve", "digest-0000000000000001"),
    ).rejects.toMatchObject({ kind: "failed" });
  });
});
