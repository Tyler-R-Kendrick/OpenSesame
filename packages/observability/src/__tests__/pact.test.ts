import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { forAgent } from "../agent-payload.js";
import { redactDeep } from "../logger.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — observability redaction", () => {
  it("refuses snake-case and camel-case credentials at model boundaries", () => {
    for (const payload of [
      { access_token: "leak" },
      { accessToken: "leak" },
      { nested: { refreshToken: "leak" } },
      { authorization: "Bearer leak" },
    ]) {
      expect(() => forAgent(JSON.stringify(payload))).toThrow(
        /secret_in_agent_payload/,
      );
    }
  });

  it("property: token_type is kept while access_token is censored", () => {
    const out = overlapCast(redactDeep({
      token_type: "Bearer",
      access_token: "LEAK",
    }));
    expect(out.token_type).toBe("Bearer");
    expect(out.access_token).toBe("[Redacted]");
  });

  it("adversarial: nested pin and access_token never survive", () => {
    const out = redactDeep({
      ctx: { session: { access_token: "LEAK", nested: { pin: "9999" } } },
    });
    expect(JSON.stringify(out)).not.toContain("LEAK");
    expect(JSON.stringify(out)).not.toContain("9999");
  });

  it("source: deep walk has a depth ceiling before recurse", () => {
    assertSourceOrder(readFileSync(join(here, "../logger.ts"), "utf8"), [
      "const MAX_REDACT_DEPTH = 12",
      "if (depth >= MAX_REDACT_DEPTH) return CENSOR",
    ]);
  });

  it("chaos: nested tokens are gone after redactDeep; cycles terminate", () => {
    const out = overlapCast(redactDeep({
      ctx: { session: { access_token: "LEAK", nested: { pin: "9999" } } },
    }));
    expect(out.ctx.session.access_token).toBe("[Redacted]");
    expect(JSON.stringify(out)).not.toContain("LEAK");
    expect(JSON.stringify(out)).not.toContain("9999");

    const node: JsonObject = { token_type: "Bearer" };
    node.self = node;
    const cyclic = overlapCast(redactDeep(node));
    expect(cyclic.token_type).toBe("Bearer");
    expect(cyclic.self).toBe("[Circular]");
  });

  it("contract: [Redacted] not plaintext; token_type remains", () => {
    const out = overlapCast(redactDeep({
      access_token: "s",
      token_type: "Bearer",
    }));
    expect(out.access_token).toBe("[Redacted]");
    expect(out.token_type).toBe("Bearer");
    expect(JSON.stringify(out)).not.toContain('"s"');
  });
});
