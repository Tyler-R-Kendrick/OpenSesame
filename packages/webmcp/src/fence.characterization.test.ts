import {
  forAgent as nodeForAgent,
  scrubLocalSecrets as nodeScrub,
} from "@opensesame/observability";
import { describe, expect, it } from "vitest";
import {
  AgentPayloadRefused,
  forAgent as portedForAgent,
  scrubLocalSecrets as portedScrub,
} from "./fence.js";

const ENV_FIXTURES = [
  {},
  { OPENSESAME_OPERATOR_TOKEN: "op-token-1234567890" },
  { OPENSESAME_ACCESS_TOKEN: "  padded-token-value  " },
  { OPENSESAME_IDENTITY_TOKEN: "short" },
  { OPENSESAME_CLAIM_PEPPER: "opaque-session:bare-value-9876" },
  {
    OPENSESAME_OPERATOR_TOKEN: "overlapping-long-token",
    OPENSESAME_ACCESS_TOKEN: "overlapping",
  },
];

/** Synthetic: `osk_` and 43 base64url characters, none of them a real key. */
const MODEL_KEY = `osk_${"A".repeat(43)}`;

const TEXT_FIXTURES = [
  "",
  "plain status text with nothing sensitive",
  "op-token-1234567890 appears once, op-token-1234567890 appears twice",
  "padded-token-value and short and bare-value-9876",
  "prefix opaque-session:bare-value-9876 suffix",
  "overlapping-long-token overlaps overlapping",
  'json {"status":"ok","refresh_token":"x"}',
  "Authorization header spelled out",
  "ghp_abcdefghijklmnop",
  "-----BEGIN PRIVATE KEY-----",
  "secret://vault/item",
  MODEL_KEY,
  `your key is ${MODEL_KEY}; it is shown once`,
  `{"note":"${MODEL_KEY}"}`,
  `Authorization: DPoP ${MODEL_KEY}`,
  `model_key_${MODEL_KEY}`,
  `osk_${"Ab_-".repeat(10)}Ab_`,
  `osk_${"A".repeat(42)}`,
  `osk_${"A".repeat(20)} ${"A".repeat(23)}`,
  `OSK_${"A".repeat(43)}`,
  "osk_AbCdEfGh",
  "kiosk_mode=on tabs=3",
];

describe("fence characterization against @opensesame/observability", () => {
  it("scrubLocalSecrets matches the node implementation on every fixture", () => {
    for (const env of ENV_FIXTURES) {
      for (const text of TEXT_FIXTURES) {
        expect(portedScrub(text, env)).toBe(nodeScrub(text, env));
      }
    }
  });

  it("forAgent matches output and refusal behavior on every fixture", () => {
    for (const env of ENV_FIXTURES) {
      for (const text of TEXT_FIXTURES) {
        let nodeRefused = false;
        let nodeValue = "";
        try {
          nodeValue = nodeForAgent(text, env);
        } catch {
          nodeRefused = true;
        }
        if (nodeRefused) {
          expect(() => portedForAgent(text, env)).toThrow(AgentPayloadRefused);
        } else {
          expect(portedForAgent(text, env)).toBe(nodeValue);
        }
      }
    }
  });
});
