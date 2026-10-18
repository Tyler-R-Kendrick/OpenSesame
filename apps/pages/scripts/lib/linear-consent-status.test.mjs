import { describe, expect, it } from "vitest";
import { knownLinearStatusCodes } from "./linear-consent-status.mjs";

function mark(label) {
  return { getAttribute: (name) => (name === "aria-label" ? label : null) };
}
describe("bounded Linear status diagnostics", () => {
  it("distinguishes exact lease/wait endings without retaining decorated or arbitrary errors", () => {
    expect(
      knownLinearStatusCodes([
        mark("lease aborted"),
        mark("Provider authorization was cancelled or expired"),
        mark("lease aborted synthetic-credential"),
        mark("Provider authorization was cancelled or expired?state=private"),
        mark({ toString: () => "lease aborted" }),
      ]),
    ).toEqual(["capability-lease-ended", "provider-wait-ended"]);
  });
  it("separates exact prep/ownership failures and deduplicates their safe codes", () => {
    expect(
      knownLinearStatusCodes([
        mark("Finish the current Linear sign-in first"),
        mark("Provider sign-in selection changed"),
        mark("Finish the current Linear sign-in first"),
        mark("Reconnect the original Linear workspace to recover its webhook"),
      ]),
    ).toEqual([
      "selection-changed",
      "sign-in-already-running",
      "wrong-recovery-workspace",
    ]);
  });
  it("does not retain unknown, credential-bearing, partial or callback text", () => {
    const result = knownLinearStatusCodes([
      mark("api-key synthetic-secret"),
      mark(
        "Finish the current Linear sign-in first?code=private&state=private",
      ),
      mark("https://linear.app/oauth/authorize?code=private"),
      mark("Saved Linear connector not found extra-secret"),
      mark(null),
      mark("__proto__"),
    ]);
    expect(result).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("distinguishes missing storage and reused windows from unrelated statuses", () => {
    expect(
      knownLinearStatusCodes([
        mark(
          "Linear OAuth requires durable browser storage; enable browser storage or use an API key",
        ),
        mark("This provider authorization window was already used"),
        mark("Linear authorization incomplete"),
      ]),
    ).toEqual(["durable-storage-unavailable", "popup-already-used"]);
  });
});
