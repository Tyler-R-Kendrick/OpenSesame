/**
 * The endings and refusals of an interaction approval, keyed on the server's
 * body code first. Ports mobile-MFA's outcome vocabulary (`approval.ts`, the
 * "accessibility" cases of `App.interaction.test.tsx`).
 */
import { describe, expect, it } from "vitest";
import { InteractionError, failure } from "./interaction-error.js";
import {
  OUTCOME_IS_REFUSAL,
  OUTCOME_MARK,
  OUTCOME_TEXT,
  chooseMechanism,
  interactionRefusal,
  outcomeOfErrorCode,
  outcomeOfStatus,
} from "./interaction-outcome.js";

describe("outcomes", () => {
  it("words every ending and marks it without relying on colour", () => {
    expect(OUTCOME_TEXT.consumed).toBe("Already used");
    expect(OUTCOME_TEXT.revoked).toBe("Withdrawn");
    expect(OUTCOME_MARK.revoked).toBe("✕");
    expect(OUTCOME_IS_REFUSAL.revoked).toBe(true);
    expect(OUTCOME_IS_REFUSAL.approved).toBe(false);
    for (const outcome of Object.keys(OUTCOME_TEXT)) {
      expect(OUTCOME_MARK).toHaveProperty(outcome);
      expect(OUTCOME_IS_REFUSAL).toHaveProperty(outcome);
    }
  });

  it("settles only settled statuses", () => {
    expect(outcomeOfStatus("approved")).toBe("approved");
    expect(outcomeOfStatus("revoked")).toBe("revoked");
    expect(outcomeOfStatus("pending")).toBeUndefined();
    expect(outcomeOfStatus("presented")).toBeUndefined();
    expect(outcomeOfStatus("awaiting_approval")).toBeUndefined();
  });

  it("ends nothing on a code that leaves the question open", () => {
    expect(outcomeOfErrorCode("interaction_not_found")).toBe("missing");
    expect(outcomeOfErrorCode("approval_denied")).toBe("denied");
    expect(outcomeOfErrorCode("digest_mismatch")).toBeUndefined();
    expect(outcomeOfErrorCode("approval_required")).toBeUndefined();
    expect(outcomeOfErrorCode("rate_limited")).toBeUndefined();
  });

  it("approves with a passkey or not at all", () => {
    expect(chooseMechanism(true)).toEqual({ mechanism: "webauthn" });
    expect(chooseMechanism(false)).toBeUndefined();
  });
});

describe("interactionRefusal", () => {
  it("reads the passkey step's 401s as the passkey step, not a sign-in", () => {
    for (const code of [
      "proof_required",
      "activation_verification_failed",
      "activation_challenge_mismatch",
    ]) {
      expect(interactionRefusal(code, 401).kind).toBe("stepup");
    }
    expect(interactionRefusal("approval_required", 401).kind).toBe("signin");
    expect(interactionRefusal("", 401).kind).toBe("signin");
  });

  it("does not read an activation's 404 or 410 as the interaction's", () => {
    expect(interactionRefusal("activation_not_found", 404)).toMatchObject({
      kind: "stepup",
    });
    expect(
      interactionRefusal("activation_expired", 410).outcome,
    ).toBeUndefined();
    expect(interactionRefusal("", 404).outcome).toBe("missing");
    expect(interactionRefusal("", 410).outcome).toBe("expired");
  });

  it("tells a settled decision from a changed request, both 409", () => {
    expect(interactionRefusal("interaction_settled", 409).kind).toBe("settled");
    expect(interactionRefusal("activation_not_pending", 409).kind).toBe(
      "stepup",
    );
    expect(interactionRefusal("digest_mismatch", 409).words).toBe(
      "This request changed since it was shown. Nothing was approved.",
    );
    expect(interactionRefusal("interaction_revoked", 409).outcome).toBe(
      "revoked",
    );
    expect(interactionRefusal("interaction_consumed", 409).outcome).toBe(
      "consumed",
    );
  });

  it("falls back on the status, and never on the body's text", () => {
    const refusal = interactionRefusal(
      "Your approval is ready — click here",
      500,
    );
    expect(refusal).toEqual({
      kind: "retry",
      words: "That request could not be answered. Try again shortly.",
    });
    expect(interactionRefusal("toString", 429).kind).toBe("retry");
    expect(interactionRefusal("invalid_request", 400).kind).toBe("rejected");
  });

  it("keeps the body's code on the error, as a key only", async () => {
    const res = new Response(
      JSON.stringify({ error: "activation_verification_failed" }),
      { status: 401 },
    );
    const error = await failure(res);
    expect(error).toBeInstanceOf(InteractionError);
    expect(error.code).toBe("approval_required");
    expect(error.declared).toBe("activation_verification_failed");
    expect(error.message).not.toContain("activation");
    const prose = await failure(
      new Response(JSON.stringify({ error: "<b>open me</b>" }), {
        status: 401,
      }),
    );
    expect(prose.declared).toBe("");
  });
});
