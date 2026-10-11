import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentPayloadRefused,
  REDACTED,
  SECRET_PATTERNS,
  forAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "../agent-payload.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Synthetic: `osk_` and 43 base64url characters, none of them a real key. */
const MODEL_KEY = `osk_${"A".repeat(43)}`;
const MODEL_KEY_PUNCTUATED = `osk_${"Ab_-".repeat(10)}Ab_`;

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

  it.each([
    ["bare", MODEL_KEY],
    ["with every base64url character", MODEL_KEY_PUNCTUATED],
    ["in a sentence", `your key is ${MODEL_KEY}; it is shown once`],
    ["in a JSON string", JSON.stringify({ note: `key ${MODEL_KEY}` })],
    ["in a URL fragment", `https://app.example/keys#ref=${MODEL_KEY}`],
    ["under a DPoP header", `Authorization: DPoP ${MODEL_KEY}`],
    ["glued to a label", `model_key_${MODEL_KEY}`],
  ])("refuses a model key %s", (_where, value) => {
    expect(looksLikeCredential(value)).toBe(true);
    expect(() => forAgent(value, {})).toThrow(AgentPayloadRefused);
  });

  it.each([
    ["one character short", `osk_${"A".repeat(42)}`],
    ["a preview", "osk_AbCdEfGh"],
    ["a space inside the run", `osk_${"A".repeat(20)} ${"A".repeat(23)}`],
    ["the prefix in upper case", `OSK_${"A".repeat(43)}`],
    ["a word that holds the prefix", "kiosk_mode=on tabs=3"],
  ])("does not refuse %s", (_what, value) => {
    expect(looksLikeCredential(value)).toBe(false);
    expect(forAgent(value, {})).toBe(value);
  });

  it("matches the model-key rule of the shared scrubber spec", () => {
    const spec: { rules: { id: string; pattern: string }[] } = JSON.parse(
      readFileSync(
        join(here, "../../../../spec/log-scrub/log-scrub.json"),
        "utf8",
      ),
    );
    const rule = spec.rules.find((candidate) => candidate.id === "model-key");
    expect(SECRET_PATTERNS.map((pattern) => pattern.source)).toEqual([
      rule?.pattern,
    ]);
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
