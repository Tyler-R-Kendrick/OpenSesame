import { describe, expect, it, vi } from "vitest";
import { CandidateCustody } from "./secrets.js";
import { assertResetGrant, fixedGrants, resetAudience, resetResource } from "./grants.js";
import { grant, run } from "./test-support.js";
import { RESET_ACTIONS } from "./types.js";

const NOW = new Date("2026-10-27T00:00:00.000Z");

describe("separate per-run capability grants", () => {
  it("accepts each exact action only with its own approved grant id", () => {
    const current = run();
    for (const action of RESET_ACTIONS) {
      const resource = action === "password_reset.domain_metadata.list"
        ? "password-reset:domain:accounts.example.test:metadata"
        : resetResource(current.domain, current.itemId);
      expect(() => assertResetGrant(
        { ...grant(action), resources: [resource] },
        current,
        action,
        NOW,
      )).not.toThrow();
    }
  });

  it("refuses wildcards, sibling actions, other runs and missing agent binding", () => {
    const current = run();
    const browser = grant();
    expect(() => assertResetGrant(
      { ...browser, resources: ["password-reset:domain:accounts.example.test:item:*"] },
      current,
      "password_reset.browser.drive",
      NOW,
    )).toThrow("exact resource");
    expect(() => assertResetGrant(
      { ...browser, actions: ["password_reset.browser.drive", "password_reset.model.plan"] },
      current,
      "password_reset.browser.drive",
      NOW,
    )).toThrow("own exact grant");
    expect(() => assertResetGrant(
      { ...browser, constraints: { ...browser.constraints, audiences: [resetAudience("run-2")] } },
      current,
      "password_reset.browser.drive",
      NOW,
    )).toThrow("another run");
    expect(() => assertResetGrant(
      { ...browser, actorInstanceId: null }, current, "password_reset.browser.drive", NOW,
    )).toThrow("agent instance");
    expect(() => fixedGrants({}).grant("password_reset.model.plan", current)).toThrow("separately approved");
  });

  it("checks password production authority before reading the method", async () => {
    const source = vi.fn(() => { throw new Error("method read"); });
    const pepper = vi.fn(() => "PERSON_PEPPER");
    const custody = new CandidateCustody(source, pepper, () => { throw new Error("grant refused"); });
    await expect(custody.withPassword(async () => undefined)).rejects.toThrow("grant refused");
    expect(source).not.toHaveBeenCalled();
    expect(pepper).not.toHaveBeenCalled();
  });
});
