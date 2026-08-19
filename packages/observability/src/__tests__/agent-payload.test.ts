import { describe, expect, it } from "vitest";
import {
  AgentPayloadRefused,
  REDACTED,
  forAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "../agent-payload.js";

describe("agent payload boundary", () => {
  it("scrubs configured secrets, their bare session form, and overlaps longest-first", () => {
    const env = {
      OPENSESAME_OPERATOR_TOKEN: " opaque-session:abcdefghij ",
      OPENSESAME_ACCESS_TOKEN: "abcdefgh",
      OPENSESAME_IDENTITY_TOKEN: "short",
      OPENSESAME_CLAIM_PEPPER: "",
    };
    expect(
      scrubLocalSecrets(
        "opaque-session:abcdefghij abcdefghij abcdefgh short",
        env,
      ),
    ).toBe(`${REDACTED} ${REDACTED} ${REDACTED} short`);
    expect(scrubLocalSecrets("safe", {})).toBe("safe");
    expect(scrubLocalSecrets("Stryker was here!", {})).toBe(
      "Stryker was here!",
    );
    expect(
      scrubLocalSecrets("prefixabcdefgh", {
        OPENSESAME_OPERATOR_TOKEN: "prefixopaque-session:abcdefgh",
      }),
    ).toBe("prefixabcdefgh");
    expect(
      scrubLocalSecrets("SENSITIVE", {
        OPENSESAME_ACCESS_TOKEN: ["x".repeat(15), "SENSITIVE"].join(""),
      }),
    ).toBe("SENSITIVE");
  });

  it.each([
    "secret://ref",
    "Bearer Operator: value",
    "client_secret",
    "clientSecret",
    "refresh_token",
    "refreshToken",
    "access_token",
    "accessToken",
    "private_key",
    "privateKey",
    '"authorization"',
    '"cookie"',
    "-----BEGIN PRIVATE KEY-----",
    "ghp_example",
  ])("refuses the credential marker %s", (value) => {
    expect(looksLikeCredential(value)).toBe(true);
    expect(() => forAgent(value, {})).toThrow(AgentPayloadRefused);
  });

  it("returns scrubbed safe text and keeps the stable refusal contract", () => {
    expect(REDACTED).toBe("[REDACTED]");
    expect(
      forAgent("token=opaque-session:abcdefghij", {
        OPENSESAME_OPERATOR_TOKEN: "opaque-session:abcdefghij",
      }),
    ).toBe(`token=${REDACTED}`);
    expect(looksLikeCredential("token_type and user_code are metadata")).toBe(
      false,
    );
    expect(new AgentPayloadRefused().message).toBe("secret_in_agent_payload");
  });
});
