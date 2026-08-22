import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { redactSecrets } from "@opensesame/sdk-cli";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — client CLI emit / session", () => {
  it("redacts before printing, including JSON-looking human text", () => {
    assertSourceOrder(readFileSync(join(here, "run.ts"), "utf8"), [
      "const redacted = redactSecrets(data)",
      'trimmed.startsWith("{")',
      "JSON.stringify(redacted",
    ]);
    assertSourceOrder(readFileSync(join(here, "run.ts"), "utf8"), [
      "writeFile(temp, JSON.stringify(session), { mode: 0o600 })",
      "chmod(temp, 0o600)",
      "rename(temp, path)",
    ]);
    assertSourceOrder(readFileSync(join(here, "run.ts"), "utf8"), [
      "async function refreshSession",
      "if (!discovery.ok) return null",
      "} catch {",
      "return null",
    ]);
  });

  it("redactSecrets strips claim and access tokens from CLI envelopes", () => {
    const redacted = overlapCast(
      redactSecrets({
        ok: true,
        access_token: "secret",
        claimToken: "osc_clm_nope",
        token_type: "Bearer",
      }),
    );
    expect(redacted.access_token).toBe("[redacted]");
    expect(redacted.claimToken).toBe("[redacted]");
    expect(redacted.token_type).toBe("Bearer");
  });
});
