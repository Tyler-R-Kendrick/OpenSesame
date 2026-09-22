import { describe, expect, it } from "vitest";
import {
  assertBrowserExecution,
  needsVaultControlledIdentity,
} from "./transport-capability.js";

const UNSUPPORTED = {
  outcome: "unsupported_in_browser",
  code: "source_unsupported",
};

describe("assertBrowserExecution (AT-BROWSER-KEY)", () => {
  it("answers the typed unsupported outcome for a vault-controlled identity", () => {
    const answer = assertBrowserExecution({
      id: "conn_1",
      transport: {
        executionTarget: "browser",
        desiredPolicy: "mtls_required",
        identityRef: { name: "vault-leaf" },
      },
    });
    expect(answer).toMatchObject(UNSUPPORTED);
    // No material, no address: the outcome names nothing but the reason.
    expect(JSON.stringify(answer)).not.toMatch(/BEGIN|key:|vault-leaf/);
  });

  it("refuses mtls_required with no browser profile even without a named identity", () => {
    expect(
      assertBrowserExecution({ transport: { desiredPolicy: "mtls_required" } }),
    ).toMatchObject(UNSUPPORTED);
  });

  it("refuses a connection that runs on host or worker", () => {
    for (const executionTarget of ["host", "worker"] as const) {
      expect(
        assertBrowserExecution({ transport: { executionTarget } }),
      ).toMatchObject(UNSUPPORTED);
    }
  });

  it("supports a plain connection and a browser-managed profile", () => {
    expect(assertBrowserExecution({})).toEqual({ outcome: "supported" });
    expect(
      assertBrowserExecution({
        transport: { executionTarget: "browser", desiredPolicy: "server_tls" },
      }),
    ).toEqual({ outcome: "supported" });
    expect(
      assertBrowserExecution({
        transport: {
          desiredPolicy: "mtls_required",
          browserProfile: { kind: "browser_managed", displayName: "Laptop" },
        },
      }),
    ).toEqual({ outcome: "supported" });
  });

  it("names exactly when a vault-controlled identity is needed", () => {
    expect(needsVaultControlledIdentity(undefined)).toBe(false);
    expect(needsVaultControlledIdentity({ identityRef: { name: "x" } })).toBe(
      true,
    );
    expect(needsVaultControlledIdentity({ desiredPolicy: "server_tls" })).toBe(
      false,
    );
  });
});
