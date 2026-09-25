import type { CapabilityState } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { capabilityStatus } from "./status.js";

function core(approved: boolean): CapabilityState {
  return {
    id: "identity.local-iam",
    tier: "core",
    distributed: true,
    permitted: approved,
    required: false,
    selected: approved,
    dependencyOf: [],
    runtimeSupported: true,
    approved,
    restartRequired: false,
    reasons: approved ? ["CORE"] : ["PROHIBITED_BY_INSTANCE"],
  };
}

describe("capabilityStatus of an always-on capability (ADR 0142)", () => {
  it("reads always on while it runs", () => {
    expect(capabilityStatus(core(true), undefined)).toEqual({
      tone: "ok",
      label: "always on",
    });
  });

  it("reads withdrawn by operator once a policy prohibits it", () => {
    expect(capabilityStatus(core(false), undefined)).toEqual({
      tone: "err",
      label: "withdrawn by operator",
    });
  });
});
