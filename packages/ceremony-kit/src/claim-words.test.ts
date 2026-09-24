import { describe, expect, it } from "vitest";
import { claimRefusal, dropRefusal } from "./claim-words.js";

describe("claim refusals", () => {
  it("contract: the body's code outranks the status", () => {
    // Three causes, one status: only the code says which one this is.
    expect(claimRefusal("invalid_user_code", 401)).toMatchObject({
      kind: "wrong_code",
      spent: false,
    });
    expect(claimRefusal("invalid_claim_token", 401)).toMatchObject({
      kind: "invalid",
      spent: true,
    });
    expect(claimRefusal("unauthorized", 401)).toMatchObject({
      kind: "signed_out",
      spent: false,
    });
  });

  it("words every server code a claim call can answer", () => {
    const cases: Array<[string, number, string, boolean]> = [
      ["too_many_attempts", 429, "locked_out", true],
      ["EXPIRED", 410, "expired", true],
      ["INVALID_TRANSITION", 422, "decided", true],
      ["CONFLICT", 409, "decided", true],
      ["invalid_token", 401, "invalid", true],
      ["INVALID_TOKEN", 401, "invalid", true],
      ["not_found", 404, "invalid", true],
      ["NOT_FOUND", 404, "invalid", true],
      ["validation_error", 400, "rejected", false],
    ];
    for (const [code, status, kind, spent] of cases) {
      expect(claimRefusal(code, status), code).toMatchObject({ kind, spent });
    }
  });

  it("falls back to the status when the body names no known code", () => {
    expect(claimRefusal("", 401).words).toBe(
      "This claim link is no longer valid. Ask for a fresh one.",
    );
    expect(claimRefusal("", 404).kind).toBe("invalid");
    expect(claimRefusal("", 410).words).toBe(
      "This claim expired. Ask for a fresh one.",
    );
    expect(claimRefusal("", 409).words).toBe(
      "This claim has already been decided.",
    );
    expect(claimRefusal("", 422).kind).toBe("decided");
    expect(claimRefusal("", 400).kind).toBe("rejected");
    expect(claimRefusal("", 500)).toMatchObject({
      kind: "unavailable",
      spent: false,
    });
    expect(claimRefusal("", 429).spent).toBe(false);
  });

  it("uses the server's own words only for a failure it cannot name", () => {
    expect(claimRefusal("", 503, "overloaded").words).toBe("overloaded");
    expect(claimRefusal("EXPIRED", 410, "raw detail").words).toBe(
      "This claim expired. Ask for a fresh one.",
    );
  });
});

describe("drop refusals", () => {
  it("maps every refusal onto a recipient-readable code", () => {
    expect(dropRefusal("invalid_user_code", 401)).toEqual({
      code: "invalid_code",
      words:
        "That code did not match this drop. Check it with the sender and try again.",
    });
    expect(dropRefusal("too_many_attempts", 429).code).toBe("invalid_code");
    expect(dropRefusal("EXPIRED", 410).code).toBe("expired");
    expect(dropRefusal("", 410).code).toBe("expired");
    expect(dropRefusal("INVALID_TRANSITION", 422)).toEqual({
      code: "already_opened",
      words: "This drop was already opened.",
    });
    expect(dropRefusal("CONFLICT", 409).code).toBe("already_opened");
    expect(dropRefusal("", 404).code).toBe("invalid");
    expect(dropRefusal("invalid_token", 401).code).toBe("invalid");
    expect(dropRefusal("", 500)).toEqual({
      code: "unreachable",
      words: "Opening the drop failed (500).",
    });
  });

  it("keeps the words a plane wrote for a person, under the code's class", () => {
    expect(
      dropRefusal("not_found", 401, "This drop is not on this device."),
    ).toEqual({ code: "invalid", words: "This drop is not on this device." });
    expect(
      dropRefusal("INVALID_TRANSITION", 401, "Already opened here."),
    ).toEqual({ code: "already_opened", words: "Already opened here." });
    expect(dropRefusal("refused", 401, "Refused.").code).toBe("invalid");
  });
});
