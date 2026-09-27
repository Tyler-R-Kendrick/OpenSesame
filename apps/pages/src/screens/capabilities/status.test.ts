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

function optional(
  reasons: CapabilityState["reasons"],
  approved: boolean,
): CapabilityState {
  return {
    ...core(approved),
    id: "agents.webmcp",
    tier: "optional",
    permitted: true,
    selected: true,
    reasons,
  };
}

describe("capabilityStatus of a capability that needs a fresh document", () => {
  it("reads reload to start once approved mid-session, never active or approved", () => {
    const expected = { tone: "warn", label: "reload to start" };
    const state = optional(["RELOAD_REQUIRED"], true);
    expect(capabilityStatus(state, "reload-required")).toEqual(expected);
    // The reason alone decides it, whatever lifecycle a caller passes.
    expect(capabilityStatus(state, undefined)).toEqual(expected);
  });

  it("an always-on one reads reload to start too, not always on", () => {
    const state: CapabilityState = {
      ...core(true),
      reasons: ["CORE", "RELOAD_REQUIRED"],
    };
    expect(capabilityStatus(state, undefined)).toEqual({
      tone: "warn",
      label: "reload to start",
    });
  });

  it("started in this document, it reads active", () => {
    expect(capabilityStatus(optional([], true), "active")).toEqual({
      tone: "ok",
      label: "active",
    });
  });
});
