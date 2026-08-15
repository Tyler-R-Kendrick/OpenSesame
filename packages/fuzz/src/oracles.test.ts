import { redactAuditMetadata } from "@opensesame/audit";
import { canonicalResource } from "@opensesame/oauth-provider";
import { canTransitionClaim } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { assertNoSecretFields } from "./oracles.js";
import { seedProvisional } from "./provisional_identity.js";

describe("fuzz oracles", () => {
  it("keeps terminal claims terminal", () => {
    expect(canTransitionClaim("completed", "pending")).toBe(false);
    expect(canTransitionClaim("revoked", "presented")).toBe(false);
  });

  it("canonicalizes resources without query or fragment", () => {
    expect(canonicalResource("https://API.Example/foo/?x=1")).toBeNull();
    expect(canonicalResource("https://API.Example/foo")).toBe(
      "https://api.example/foo",
    );
  });

  it("redacts audit secrets", () => {
    expect(() =>
      assertNoSecretFields({ action: "ok", access_token: "s" }, (v) =>
        redactAuditMetadata(v as Record<string, unknown>),
      ),
    ).not.toThrow();
  });

  it("provisional session ids do not authenticate", async () => {
    await seedProvisional();
  });
});
