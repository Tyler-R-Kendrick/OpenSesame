import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@opensesame/os-domain";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { forAgent } from "../agent-payload.js";
import { redactDeep } from "../logger.js";

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
    const out = redactDeep({
      token_type: "Bearer",
      access_token: "LEAK",
    });
    expect(out.token_type).toBe("Bearer");
    expect(out.access_token).toBe("[REDACTED]");
  });

  it("adversarial: nested pin and access_token never survive", () => {
    const out = redactDeep({
      ctx: { session: { access_token: "LEAK", nested: { pin: "9999" } } },
    });
    expect(JSON.stringify(out)).not.toContain("LEAK");
    expect(JSON.stringify(out)).not.toContain("9999");
  });

  it("source: deep walk has a depth ceiling before recurse", () => {
    // The walk moved to the shared scrubber (ADR 0156); the logger runs it.
    assertSourceOrder(
      readFileSync(join(here, "../../../log-scrub/src/scrub.ts"), "utf8"),
      ["const MAX_DEPTH = 12", "if (depth >= MAX_DEPTH) return REDACTED"],
    );
  });

  it("chaos: nested tokens are gone after redactDeep; cycles terminate", () => {
    const out = redactDeep({
      ctx: { session: { access_token: "LEAK", nested: { pin: "9999" } } },
    });
    expect(out.ctx.session.access_token).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("LEAK");
    expect(JSON.stringify(out)).not.toContain("9999");

    const node: JsonObject = { token_type: "Bearer" };
    node.self = node;
    const cyclic = redactDeep(node);
    expect(cyclic.token_type).toBe("Bearer");
    expect(cyclic.self).toBe("[Circular]");
  });

  it("contract: [REDACTED] not plaintext; token_type remains", () => {
    const out = redactDeep({
      access_token: "s",
      token_type: "Bearer",
    });
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.token_type).toBe("Bearer");
    expect(JSON.stringify(out)).not.toContain('"s"');
  });
});
