/**
 * The approval ceremony on the wire. Ports mobile-MFA's
 * `App.interaction.test.tsx` ("resolving an interaction", "approving",
 * "denying", "terminal states") onto the model, through the real interaction
 * client and a fake Identity API.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ID,
  API,
  DIGEST,
  LINK,
  OTHER_DIGEST,
  activationBegin,
  activationDone,
  authenticator,
  ceremony,
  detailBody,
  json,
  summaryBody,
} from "./interaction-approval.fixture.js";
import { InteractionStepUpError } from "./interaction-approval.js";

const CHANGED =
  "This request changed since it was shown. Nothing was approved.";

/** Resolve, sign in, read: the ceremony on its review phase. */
async function reviewing(...args: Parameters<typeof ceremony>) {
  const run = ceremony(...args);
  await run.approval.load();
  run.signIn();
  await run.approval.read();
  expect(run.approval.phase().kind).toBe("review");
  return run;
}

describe("resolving an interaction", () => {
  it("resolves unauthenticated and asks for sign-in before showing anything", async () => {
    const { approval, calls } = ceremony({ resolve: json(200, summaryBody()) });
    const step = await approval.load();

    const [first] = calls;
    // The canonical short link, through the anonymous fetch, with no bearer:
    // scanning is not approving.
    expect(first?.url).toBe(LINK);
    expect(first?.through).toBe("anonymous");
    expect(first?.init.method).toBe("GET");
    expect(first?.init.headers).toEqual({ accept: "application/json" });
    expect(step?.phase).toEqual({
      kind: "signin",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(step?.message).toBeNull();
    // Nothing about who is asking whom has been read yet.
    expect(calls).toHaveLength(1);
  });

  it("reads the approver's view with the session once signed in", async () => {
    const { approval, calls } = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody()),
    });
    const phase = approval.phase();
    if (phase.kind !== "review") throw new Error("not reviewing");
    expect(phase.view).toEqual({
      title: "Approve this device",
      match: "Match 42",
      facts: [
        "From inbox_9f2",
        "Resource acme/paperwork",
        "Expires 2026-09-01T00:00:00.000Z",
      ],
    });
    const read = calls.find(({ url }) => url === API);
    expect(read?.through).toBe("session");
    expect(read?.init.headers).toEqual({
      authorization: "Bearer pst_test_token",
    });
  });

  it("reads the detail straight away when no approver is required", async () => {
    const { approval } = ceremony({
      resolve: json(200, summaryBody({ requiresApprover: false })),
      detail: json(200, detailBody()),
    });
    expect((await approval.load())?.phase.kind).toBe("review");
  });

  it("asks for a sign-in again, without a fetch, when there is still none", async () => {
    const { approval, calls } = ceremony({ resolve: json(200, summaryBody()) });
    await approval.load();
    const step = await approval.read();
    expect(step?.phase.kind).toBe("signin");
    expect(step?.message).toBe("Sign in first.");
    expect(calls).toHaveLength(1);
  });

  it("omits the match when there is no binding message", async () => {
    const { approval } = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody({ bindingMessage: undefined })),
    });
    const phase = approval.phase();
    if (phase.kind !== "review") throw new Error("not reviewing");
    expect(phase.view.match).toBeUndefined();
    expect(phase.view.facts).toHaveLength(3);
  });

  it("renders the summary as text, never as markup", async () => {
    const { approval } = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody({ bindingMessage: "<img src=x>ACME" })),
    });
    const phase = approval.phase();
    if (phase.kind !== "review") throw new Error("not reviewing");
    expect(phase.view.match).toBe("img src=xACME");
  });
});

describe("approving", () => {
  it("approves through a server-verified, interaction-scoped activation", async () => {
    const auth = authenticator();
    const run = await reviewing(
      {
        resolve: json(200, summaryBody()),
        detail: json(200, detailBody()),
        activation: activationBegin(),
        complete: activationDone(),
        approve: json(200, detailBody({ status: "approved" })),
      },
      { port: auth.port },
    );
    const step = await run.approval.approve();

    // Begun for THIS digest and THIS verb: never a generic assertion.
    expect(run.bodyOf("/activation")).toEqual({
      requestDigest: DIGEST,
      decision: "approved",
    });
    // The authority's options reach the authenticator unaltered.
    expect(auth.seen).toEqual([{ challenge: "aGk" }]);
    expect(run.bodyOf("/activation/complete")).toEqual({
      activationId: ACTIVATION_ID,
      credentialId: "cred-1",
      clientDataJSON: "Y2Q",
      authenticatorData: "YWQ",
      signature: "c2ln",
    });
    // The digest echo and the verified activation's handle, and nothing that
    // could pass for a client-built proof.
    expect(run.bodyOf("/approve")).toEqual({
      requestDigest: DIGEST,
      activationId: ACTIVATION_ID,
    });
    expect(step?.phase).toEqual({ kind: "done", outcome: "approved" });
  });

  it("never falls back to a bare approve when the step-up is not verified", async () => {
    const run = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody()),
      activation: activationBegin(),
      complete: json(401, { error: "activation_verification_failed" }),
    });
    const step = await run.approval.approve();

    expect(run.calls.some(({ url }) => url.endsWith("/approve"))).toBe(false);
    // Still the question, worded as the passkey step — not a sign-in prompt,
    // which is what mobile-MFA read this 401 as.
    expect(step?.phase.kind).toBe("review");
    expect(step?.message).toBe(
      "The passkey was not confirmed. Nothing was approved. Try again.",
    );
  });

  it("stops when the authenticator is cancelled, before anything is verified", async () => {
    const auth = authenticator(true, async () => {
      throw new InteractionStepUpError("cancelled");
    });
    const run = await reviewing(
      {
        resolve: json(200, summaryBody()),
        detail: json(200, detailBody()),
        activation: activationBegin(),
      },
      { port: auth.port },
    );
    const step = await run.approval.approve();
    expect(step?.message).toBe("Passkey cancelled. Nothing was approved.");
    expect(
      run.calls.some(({ url }) =>
        /\/(activation\/complete|approve)$/.test(url),
      ),
    ).toBe(false);
  });

  it("refuses an activation the server confirmed under another id", async () => {
    const run = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody()),
      activation: activationBegin(),
      complete: activationDone({ activationId: "apac_someone_else" }),
    });
    const step = await run.approval.approve();
    expect(run.calls.some(({ url }) => url.endsWith("/approve"))).toBe(false);
    expect(step?.phase.kind).toBe("review");
  });

  it("refuses a digest that changed since it was shown, before any fetch", async () => {
    let detail = detailBody();
    const run = await reviewing({
      resolve: json(200, summaryBody()),
      detail: () => json(200, detail),
    });
    // The screen goes away and comes back to a rewritten request.
    detail = detailBody({ requestDigest: OTHER_DIGEST });
    expect((await run.approval.read())?.message).toBe(CHANGED);

    const before = run.calls.length;
    const step = await run.approval.approve();
    expect(run.calls.length).toBe(before);
    expect(step?.message).toBe(CHANGED);
    expect((await run.approval.deny())?.message).toBe(CHANGED);
    expect(run.calls.length).toBe(before);
  });

  it("refuses an interaction that carries no digest at all, before any fetch", async () => {
    const run = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody({ requestDigest: undefined })),
    });
    expect(run.approval.phase().kind).toBe("review");
    const before = run.calls.length;
    const step = await run.approval.approve();
    expect(run.calls.length).toBe(before);
    expect(step?.message).toBe("This request carries nothing to approve.");
  });

  it("offers no approval without a passkey, and keeps deny", async () => {
    const run = await reviewing(
      {
        resolve: json(200, summaryBody({ kind: "transaction_authorization" })),
        detail: json(200, detailBody({ kind: "transaction_authorization" })),
        deny: json(200, detailBody({ status: "denied" })),
      },
      { port: authenticator(false).port },
    );
    const phase = run.approval.phase();
    expect(phase.kind === "review" && phase.mechanism).toBeUndefined();
    const before = run.calls.length;
    expect((await run.approval.approve())?.message).toBe(
      "Needs a passkey. This device has none.",
    );
    expect(run.calls.length).toBe(before);
    expect((await run.approval.deny())?.phase).toEqual({
      kind: "done",
      outcome: "denied",
    });
  });

  it("reads a decision that already stands back, rather than calling it a change", async () => {
    let detail = detailBody();
    const run = await reviewing({
      resolve: json(200, summaryBody()),
      detail: () => json(200, detail),
      activation: activationBegin(),
      complete: activationDone(),
      approve: () => {
        detail = detailBody({ status: "approved" });
        return json(409, { error: "interaction_settled" });
      },
    });
    const step = await run.approval.approve();
    expect(step?.phase).toEqual({ kind: "done", outcome: "approved" });
  });
});

describe("denying", () => {
  it("echoes the digest and needs no proof", async () => {
    const run = await reviewing({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody()),
      deny: json(200, detailBody({ status: "denied" })),
    });
    const step = await run.approval.deny();
    expect(run.bodyOf("/deny")).toEqual({ requestDigest: DIGEST });
    expect(run.calls.some(({ url }) => url.endsWith("/activation"))).toBe(
      false,
    );
    expect(step?.phase).toEqual({ kind: "done", outcome: "denied" });
  });
});
