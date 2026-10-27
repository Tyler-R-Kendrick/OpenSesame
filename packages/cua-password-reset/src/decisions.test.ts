import { describe, expect, it } from "vitest";
import {
  decide,
  detectChallenge,
  guardDecision,
  legalCandidates,
  modelObservation,
  selectedAction,
} from "./decisions.js";
import { maskObservation } from "./masking.js";
import { ORIGIN, observation } from "./test-support.js";

const fields = [
  { ref: "e1", kind: "email" as const, label: "person@example.test" },
  { ref: "e2", kind: "button" as const, label: "Continue" },
];

describe("typed decisions", () => {
  it("selects only grounded candidate ids and redacts identifiers", async () => {
    let sent = "";
    const current = observation(fields);
    const decision = await decide(
      {
        decide: async (input) => {
          sent = JSON.stringify(input);
          const candidate = input.candidates.find(
            (entry) => entry.action.kind === "click",
          );
          return (
            candidate && {
              kind: "act",
              observationId: current.id,
              candidateId: candidate.id,
              effectId: candidate.effectId,
            }
          );
        },
      },
      current,
      [ORIGIN],
    );
    expect(selectedAction(decision, current)).toMatchObject({
      kind: "click",
      ref: "e2",
    });
    expect(sent).not.toContain("person@example.test");
    expect(
      legalCandidates(current).every((entry) => !("value" in entry.action)),
    ).toBe(true);
  });

  it("rejects stale, off-origin, unknown-field and invented candidates", () => {
    expect(() =>
      guardDecision({ kind: "finish", observationId: "old" }, observation(), [
        ORIGIN,
      ]),
    ).toThrow("stale");
    expect(() =>
      guardDecision(
        { kind: "finish", observationId: "observation-1" },
        observation(),
        ["https://other.test"],
      ),
    ).toThrow("outside");
    expect(() =>
      guardDecision(
        {
          kind: "act",
          observationId: "observation-1",
          candidateId: "c99",
          effectId: "forged",
        },
        observation(),
        [ORIGIN],
      ),
    ).toThrow("not a legal");
    expect(() =>
      guardDecision(
        {
          kind: "finish",
          observationId: "observation-1",
          value: "secret",
        },
        observation(),
        [ORIGIN],
      ),
    ).toThrow();
  });

  it.each([
    ["Complete the captcha", "captcha"],
    ["Use your passkey", "passkey"],
    ["We sent a text message", "sms"],
    ["Two-factor authentication", "two_fa"],
    ["Enter your authenticator code", "totp"],
  ])("delegates %s to the person", (label, challenge) => {
    expect(
      detectChallenge(observation([{ ref: "e1", kind: "text", label }])),
    ).toBe(challenge);
  });

  it("offers no autonomous OTP or passkey action", () => {
    const candidates = legalCandidates(
      observation([{ ref: "e1", kind: "otp", label: "Code" }]),
    );
    expect(
      candidates.filter((candidate) => candidate.action.kind === "await-human"),
    ).toHaveLength(1);
    expect(
      candidates.some((candidate) => candidate.action.kind === "fill-field"),
    ).toBe(false);
  });
});

describe("observation masking", () => {
  it("removes raw screenshots, credentials and sensitive canaries", async () => {
    const input = {
      ...observation([
        { ref: "e1", kind: "password" as const, label: "real-password-canary" },
        { ref: "e2", kind: "email" as const, label: "person@example.test" },
      ]),
      screenshot: "raw-password-pixels",
      sensitiveValues: ["real-password-canary", "person@example.test"],
    };
    const safe = await maskObservation(input, {
      mask: async () => "data:image/png;base64,bWFza2Vk",
    });
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("real-password-canary");
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("raw-password-pixels");
    expect(safe.screenshot).toBeUndefined();
    expect(safe.maskedScreenshot).toBe("data:image/png;base64,bWFza2Vk");
  });

  it("refuses to send an unmasked screenshot", () => {
    expect(() =>
      modelObservation({ ...observation(), screenshot: "raw" }),
    ).toThrow("masked");
  });
});
