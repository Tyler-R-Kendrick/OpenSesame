import type { ApprovalProof, BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  CeremonyRequestError,
  InteractionError,
  type InteractionErrorCode,
  createInteractionClient,
} from "./index.js";

const REF = `i_${"a".repeat(24)}.${"b".repeat(32)}`;
const DIGEST = "d".repeat(64);

const DETAIL_BODY = {
  id: "int_1",
  kind: "transaction_authorization",
  status: "awaiting_approval",
  expiresAt: "2026-09-01T10:00:00.000Z",
  createdAt: "2026-09-01T09:55:00.000Z",
  requiresApprover: true,
  requesterRef: "req_9",
  bindingMessage: "Pay ACME Ltd 42.00 EUR",
  requestDigest: DIGEST,
  resourceRef: "conn_7",
  authorizationDetails: [{ type: "payment" }, "not-an-object"],
};

const PROOF: ApprovalProof = {
  mechanism: "webauthn",
  boundDigest: DIGEST,
  assurance: "verified",
  verifiedAt: new Date("2026-09-01T09:59:00.000Z"),
};

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FetchRecorder {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
}

/** A fetch that records what it was asked for, so the wire shape is assertable. */
function recorder(respond: () => Response): FetchRecorder {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  };
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, bearer?: () => string | null) {
  return createInteractionClient({
    baseUrl: "https://id.example/",
    fetchImpl,
    ...(bearer === undefined ? undefined : { bearer }),
  });
}

function only(calls: FetchCall[]): FetchCall {
  const call = calls[0];
  if (call === undefined) throw new Error("expected fetch to be called");
  return call;
}

async function codeOf<Answer>(promise: Promise<Answer>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InteractionError) return error.code;
    return `unexpected:${String(error)}`;
  }
  return "no-throw";
}

describe("interaction client — happy paths", () => {
  it("resolves the unauthenticated summary without sending a bearer", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({
        kind: "device_authorization",
        status: "pending",
        expiresAt: "2026-09-01T10:00:00.000Z",
        requiresApprover: true,
      }),
    );
    const summary = await client(
      fetchImpl,
      () => "bearer-value",
    ).resolveInteraction(REF);
    expect(summary.kind).toBe("device_authorization");
    expect(summary.expiresAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(summary.requiresApprover).toBe(true);
    const call = only(calls);
    // The trailing slash on the base is normalized away rather than doubled.
    expect(call.url).toBe(`https://id.example/i/${REF}`);
    // The stranger's-camera path must work with no credentials at all. The
    // `accept` header is required rather than incidental: `/i/<ref>` content-
    // negotiates, and without it the route answers with the HTML page a
    // browser would get instead of the summary this client parses.
    expect(call.init.headers).toEqual({ accept: "application/json" });
    expect(call.init.headers).not.toHaveProperty("authorization");
  });

  it("sends the bearer on the approver's read and drops non-object details", async () => {
    const { calls, fetchImpl } = recorder(() => json(DETAIL_BODY));
    const detail = await client(
      fetchImpl,
      () => "bearer-value",
    ).readInteraction(REF);
    expect(detail.id).toBe("int_1");
    expect(detail.requesterRef).toBe("req_9");
    expect(detail.requestDigest).toBe(DIGEST);
    expect(detail.authorizationDetails).toEqual([{ type: "payment" }]);
    const call = only(calls);
    expect(call.url).toBe(`https://id.example/v1/interactions/${REF}`);
    expect(call.init.headers).toEqual({ authorization: "Bearer bearer-value" });
  });

  it("omits the header once the surface withdraws the bearer", async () => {
    const { calls, fetchImpl } = recorder(() => json(DETAIL_BODY));
    await client(fetchImpl, () => null).readInteraction(REF);
    expect(only(calls).init.headers).toEqual({});
  });

  it("echoes the digest on approve and on deny", async () => {
    const { calls, fetchImpl } = recorder(() => json(DETAIL_BODY));
    const subject = client(fetchImpl, () => "bearer-value");
    await subject.approveInteraction(REF, {
      requestDigest: DIGEST,
      proof: PROOF,
    });
    await subject.denyInteraction(REF, { requestDigest: DIGEST });
    const bodies = calls.map((call) => JSON.parse(String(call.init.body)));
    expect(bodies[0]).toEqual({
      requestDigest: DIGEST,
      proof: {
        mechanism: "webauthn",
        boundDigest: DIGEST,
        assurance: "verified",
        verifiedAt: "2026-09-01T09:59:00.000Z",
      },
    });
    expect(bodies[1]).toEqual({ requestDigest: DIGEST });
  });
});

describe("interaction client — refusals", () => {
  it("will not approve with a proof bound to a different request", async () => {
    const { calls, fetchImpl } = recorder(() => json(DETAIL_BODY));
    const other: ApprovalProof = { ...PROOF, boundDigest: "e".repeat(64) };
    expect(
      await codeOf(
        client(fetchImpl).approveInteraction(REF, {
          requestDigest: DIGEST,
          proof: other,
        }),
      ),
    ).toBe("digest_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("will not put a malformed reference into a URL path", async () => {
    const { calls, fetchImpl } = recorder(() => json(DETAIL_BODY));
    expect(await codeOf(client(fetchImpl).resolveInteraction("../admin"))).toBe(
      "interaction_not_found",
    );
    expect(await codeOf(client(fetchImpl).readInteraction("i_a.b"))).toBe(
      "interaction_not_found",
    );
    expect(calls).toHaveLength(0);
  });

  it.each<[number, InteractionErrorCode]>([
    [401, "approval_required"],
    [403, "approval_denied"],
    [404, "interaction_not_found"],
    [409, "digest_mismatch"],
    [410, "interaction_expired"],
    [429, "rate_limited"],
    [500, "interaction_unavailable"],
    [502, "interaction_unavailable"],
  ])("maps %i to %s", async (status, expected) => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status });
    expect(await codeOf(client(fetchImpl).resolveInteraction(REF))).toBe(
      expected,
    );
  });

  it.each<[InteractionErrorCode]>([
    ["interaction_revoked"],
    ["interaction_consumed"],
    ["interaction_expired"],
  ])("lets a 410 body select %s from the closed set", async (declared) => {
    const fetchImpl: typeof fetch = async () => json({ error: declared }, 410);
    expect(await codeOf(client(fetchImpl).resolveInteraction(REF))).toBe(
      declared,
    );
  });

  it("ignores a body code that is not one of ours", async () => {
    const fetchImpl: typeof fetch = async () => json({ error: "teapot" }, 404);
    expect(await codeOf(client(fetchImpl).resolveInteraction(REF))).toBe(
      "interaction_not_found",
    );
  });

  it("never puts a server body into the thrown message", async () => {
    const leak = "access_token=ya29.SUPER-SECRET&sid=abc";
    const responders: Array<() => Response> = [
      () => new Response(leak, { status: 500 }),
      () => json({ error: leak, message: leak }, 500),
    ];
    for (const respond of responders) {
      const fetchImpl: typeof fetch = async () => respond();
      let caught: unknown;
      try {
        await client(fetchImpl).resolveInteraction(REF);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InteractionError);
      // Catchable by every surface written before interactions existed.
      expect(caught).toBeInstanceOf(CeremonyRequestError);
      /* SAFETY: the two assertions immediately above have already checked
         `caught` is an `InteractionError`, so reading `Error.message` off it is
         a narrowing the assertions established rather than a guess. */
      const message = (caught as Error).message;
      expect(message).not.toContain("access_token");
      expect(message).not.toContain("SUPER-SECRET");
      expect(message).not.toContain(leak);
      expect(message).toBe(
        "That request could not be answered. Try again shortly.",
      );
    }
  });

  it("drops a transport failure's message, which often carries the URL", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`connect ECONNREFUSED https://id.example/${REF}?token=x`);
    };
    let caught: unknown;
    try {
      await client(fetchImpl).resolveInteraction(REF);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InteractionError);
    /* SAFETY: the assertion on the line above has checked the instance, so the
       `code` field this test is about is established to exist. */
    expect((caught as InteractionError).code).toBe("interaction_unavailable");
    /* SAFETY: the same checked instance — an `InteractionError` is an `Error`,
       so `message` is present by that class contract. */
    expect((caught as Error).message).not.toContain("ECONNREFUSED");
  });

  it("treats an unreadable success body as unavailable, never as an answer", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("<html>captive portal</html>", { status: 200 });
    expect(await codeOf(client(fetchImpl).resolveInteraction(REF))).toBe(
      "interaction_unavailable",
    );
  });

  it("treats a success body missing required fields as unavailable", async () => {
    const fetchImpl: typeof fetch = async () => json({ kind: "claim" });
    expect(await codeOf(client(fetchImpl).resolveInteraction(REF))).toBe(
      "interaction_unavailable",
    );
  });
});
