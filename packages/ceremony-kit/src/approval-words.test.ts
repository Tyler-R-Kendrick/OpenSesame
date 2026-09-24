import { describe, expect, it } from "vitest";
import {
  APPROVAL_WORDS,
  arrivedViaSentence,
  assuranceSummary,
  channelLabel,
  channelName,
  describeDetail,
  needsCeremony,
  requirementSentence,
  riskSentence,
} from "./approval-copy.js";
import { approvalRefusal } from "./approval-words.js";

describe("approvalRefusal — the code first, then the status", () => {
  it.each([
    ["comparison_mismatch", 409, "comparison_mismatch", false],
    ["comparison_mismatch", 422, "comparison_mismatch", false],
    ["comparison_exhausted", 409, "comparison_exhausted", false],
    ["comparison_expired", 410, "comparison_expired", false],
    ["comparison_required", 403, "comparison_required", false],
    ["activation_expired", 410, "activation_expired", false],
    ["activation_not_found", 404, "activation_expired", false],
    ["activation_verification_failed", 401, "activation_failed", false],
    ["activation_challenge_mismatch", 401, "activation_failed", false],
    ["activation_already_consumed", 409, "activation_failed", false],
    ["activation_policy_changed", 409, "policy_changed", false],
    ["assurance_insufficient", 403, "assurance", false],
    ["binding_revoked", 403, "revoked", true],
    ["binding_not_usable", 403, "revoked", true],
    ["digest_mismatch", 409, "changed", true],
    ["request_not_pending", 422, "already_decided", true],
    ["invalid_transition", 422, "already_decided", true],
    ["conflict", 409, "conflict", false],
    ["expired", 410, "expired", true],
    ["not_found", 404, "not_found", true],
    ["prompt_rate_limited", 429, "unavailable", false],
  ])("%s (%i) reads as %s", (code, status, kind, ends) => {
    expect(approvalRefusal(code, status)).toMatchObject({ kind, ends });
  });

  it.each([
    [401, "signin"],
    [403, "not_yours"],
    [404, "not_found"],
    [409, "changed"],
    [410, "expired"],
    [422, "already_decided"],
    [503, "unavailable"],
    [0, "unreachable"],
  ])("with no code, %i reads as %s", (status, kind) => {
    expect(approvalRefusal("", status).kind).toBe(kind);
  });

  it("names the status when nothing else is known", () => {
    expect(approvalRefusal("", 418).words).toBe(
      "That did not go through (418).",
    );
  });

  it("says nothing was decided wherever that is the fact", () => {
    for (const code of [
      "digest_mismatch",
      "activation_expired",
      "binding_revoked",
    ]) {
      expect(approvalRefusal(code, 409).words).toMatch(
        /[Nn]othing was decided/,
      );
    }
  });
});

describe("approval copy", () => {
  it("never prints a reason code raw", () => {
    for (const code of [
      "phishing_resistance",
      "subject_kind:human",
      "comparison",
    ]) {
      const sentence = requirementSentence(code);
      expect(sentence).not.toContain(code);
    }
    expect(requirementSentence("phishing_resistance")).toMatch(
      /needs a passkey bound to this site/,
    );
    // One the server adds later still reads as a sentence.
    expect(requirementSentence("new_thing")).toBe(
      'Your operator requires "new thing" for this request.',
    );
    expect(requirementSentence("constructor")).toMatch(
      /Your operator requires/,
    );
  });

  it("words a risk class, never prints it", () => {
    expect(riskSentence("critical")).toMatch(/most sensitive kind of request/);
    expect(riskSentence("critical")).not.toMatch(/\bcritical\b/);
    expect(riskSentence("toString")).toMatch(/classed this request/);
  });

  it("names the channel, and says it decided nothing", () => {
    expect(channelLabel("telegram")).toBe("Telegram");
    expect(channelName("in_app")).toBe("OpenSesame inbox");
    expect(channelLabel("carrier_pigeon")).toBe("carrier pigeon");
    expect(arrivedViaSentence("telegram")).toMatch(
      /^You got here from Telegram\. That channel only pointed you at this page/,
    );
  });

  it("describes what a detail would do", () => {
    expect(
      describeDetail({
        type: "connector",
        actions: ["deploy"],
        locations: ["prod-billing"],
      }),
    ).toBe("deploy — prod-billing");
    expect(describeDetail({ type: "connector", identifier: "db" })).toBe(
      "use — db",
    );
  });

  it("summarizes what a row will take", () => {
    const hard = {
      requireTransactionBoundActivation: true,
      requireComparison: true,
      required: ["phishing_resistance"],
    };
    expect(assuranceSummary(hard)).toBe(
      "Needs a passkey touch for this exact request and the six-digit code from where it started.",
    );
    expect(needsCeremony(hard)).toBe(true);
    const easy = {
      requireTransactionBoundActivation: false,
      requireComparison: false,
      required: [],
    };
    expect(assuranceSummary(easy)).toBe("Needs your decision — nothing extra.");
    expect(
      assuranceSummary({ ...easy, required: ["subject_kind:human"] }),
    ).toMatch(/nothing extra/);
    expect(needsCeremony(easy)).toBe(false);
    expect(assuranceSummary(null)).toBe(APPROVAL_WORDS.unknownAssurance);
  });
});
