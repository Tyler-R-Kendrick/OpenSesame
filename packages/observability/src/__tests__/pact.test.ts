import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDeep } from "../logger.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — observability redaction", () => {
  it("source: deep walk has a depth ceiling before recurse", () => {
    assertSourceOrder(readFileSync(join(here, "../logger.ts"), "utf8"), [
      "const MAX_REDACT_DEPTH = 12",
      "if (depth >= MAX_REDACT_DEPTH) return CENSOR",
    ]);
  });

  it("chaos: nested tokens are gone after redactDeep", () => {
    const out = redactDeep({
      ctx: { session: { access_token: "LEAK", nested: { pin: "9999" } } },
    }) as { ctx: { session: { access_token: string } } };
    expect(out.ctx.session.access_token).toBe("[Redacted]");
    expect(JSON.stringify(out)).not.toContain("LEAK");
    expect(JSON.stringify(out)).not.toContain("9999");
  });
});
