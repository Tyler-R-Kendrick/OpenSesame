// @vitest-environment jsdom
/**
 * The `/i/:ref` and `/approve/:ref` route models (ADR 0140 plan step 9): a
 * reference opens only on the path that names it, a refused link stays
 * refused when its scrubbed path is read again, and every word is
 * ceremony-kit's.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  captureApprovalArrivalFromPage,
  peekApprovalArrival,
  resetApprovalArrivalForTests,
} from "./approvals-link.js";
import {
  approvalEntry,
  approvalStepWords,
  endingMark,
  reviewFacts,
} from "./approvals-route.js";
import {
  captureInteractionArrivalFromPage,
  resetInteractionArrivalForTests,
} from "./interactions-link.js";
import {
  interactionEntry,
  interactionStepWords,
  outcomeMark,
} from "./interactions-route.js";

const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";

afterEach(() => {
  resetInteractionArrivalForTests();
  resetApprovalArrivalForTests();
  history.replaceState(null, "", "/");
});

describe("interaction route model", () => {
  it("opens a reference only on the path that names it", () => {
    const arrival = { kind: "interaction", ref: REF } as const;
    expect(interactionEntry(arrival, `/i/${REF}`)).toEqual({
      kind: "ceremony",
      ref: REF,
    });
    expect(interactionEntry(arrival, "/i/i_other.0123456789abcdef")).toEqual(
      expect.objectContaining({ kind: "ended", outcome: "missing" }),
    );
    expect(interactionEntry({ kind: "refused" }, `/i/${REF}`)).toEqual(
      expect.objectContaining({ kind: "ended", outcome: "refused" }),
    );
  });

  it("keeps a refused link refused when its clean path is read again", () => {
    history.replaceState(null, "", `/i/${REF}#token=leaked`);
    expect(captureInteractionArrivalFromPage()).toEqual({ kind: "refused" });
    expect(location.hash).toBe("");
    expect(captureInteractionArrivalFromPage()).toEqual({ kind: "refused" });
  });

  it("trays only an ending the person did not choose", () => {
    const done = (outcome: "approved" | "denied" | "expired") => ({
      phase: { kind: "done", outcome } as const,
      message: null,
    });
    expect(interactionStepWords(done("approved"))).toBeNull();
    expect(interactionStepWords(done("denied"))).toBeNull();
    expect(interactionStepWords(done("expired"))).toBe(
      "That request has expired.",
    );
    expect(outcomeMark("approved")).toEqual({
      tone: "ok",
      label: "Approved",
      words: "Approved",
    });
  });
});

describe("approval route model", () => {
  it("opens a request only on the path that names it", () => {
    const arrival = { kind: "request", ref: "areq_1" } as const;
    expect(approvalEntry(arrival, "/approve/areq_1")).toEqual({
      kind: "review",
      ref: "areq_1",
    });
    expect(approvalEntry(arrival, "/approve/areq_2").kind).toBe("ended");
    expect(approvalEntry({ kind: "refused" }, "/approve/areq_1")).toEqual({
      kind: "ended",
      words: "That was refused as malformed. Nothing was decided.",
    });
  });

  it("keeps a refused link refused when its clean path is read again", () => {
    history.replaceState(null, "", "/approve/areq_1?access_token=x");
    expect(captureApprovalArrivalFromPage()).toEqual({ kind: "refused" });
    expect(location.search).toBe("");
    expect(captureApprovalArrivalFromPage()).toEqual({ kind: "refused" });
    expect(peekApprovalArrival()).toEqual({ kind: "refused" });
  });

  it("reads a review's facts in ceremony-kit's words", () => {
    const facts = reviewFacts({
      kind: "review",
      request: {
        authReqId: "areq_1",
        status: "pending",
        bindingMessage: "Deploy",
        requestDigest: "v2:d",
        authorizationDetails: [
          { type: "connector", actions: ["deploy"], locations: ["prod"] },
        ],
        expiresAt: "2030-01-01T00:00:00.000Z",
        assurance: null,
      },
      requirement: {
        riskClass: "low",
        policyDigest: "v1:p",
        maximumApprovalAgeSeconds: 0,
        requireTransactionBoundActivation: false,
        requireComparison: false,
        required: [],
        arrivedVia: "slack",
      },
    });
    expect(facts.asker).toBe("Not named");
    expect(facts.grants).toEqual(["deploy — prod"]);
    expect(facts.needs[0]).toMatch(/routine request/);
    expect(facts.needs.at(-1)).toMatch(/You got here from Slack/);
  });

  it("marks a decision the person made apart from one that ended without them", () => {
    expect(
      endingMark({ kind: "approved", words: "Approved. Whoever asked…" }),
    ).toEqual(expect.objectContaining({ title: "Approved", tone: "ok" }));
    const ended = {
      kind: "ended",
      title: "This request is no longer open",
      words: "gone",
    } as const;
    expect(endingMark(ended).tone).toBe("err");
    expect(
      approvalStepWords({
        phase: { kind: "done", ending: ended },
        message: null,
        alarm: false,
      }),
    ).toBe("gone");
  });
});
