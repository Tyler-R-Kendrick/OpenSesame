import { describe, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import {
  compiledApiKeyRoute,
  compiledOidcRoute,
} from "./native-connector-availability.js";
import {
  type NativeConnectorDriver,
  nativeConnectorWithdrawn,
  registerNativeConnectorDriver,
  resetNativeConnectorDrivers,
} from "./native-connector-drivers.js";

const driver: NativeConnectorDriver = {
  cleanup: { classification: () => ({}) } as never,
  supports: () => true,
  configure: async () => ({}) as never,
  verify: async () => ({}) as never,
  invoke: async () => ({ label: "", items: [] }),
};

describe("compiled connector availability", () => {
  it("admits researched presets, compiled key flows and instance routes", () => {
    for (const id of ["attio", "polar", "fal-ai", "higgsfield", "obsidian"])
      expect(compiledApiKeyRoute(id), id).toBe(true);
    for (const id of ["aws", "snowflake", "github", "s3"])
      expect(compiledApiKeyRoute(id), id).toBe(true);
    expect(compiledOidcRoute("vault")).toBe(true);
    expect(compiledOidcRoute("openbao")).toBe(true);
  });

  it("refuses plans without a browser-verifiable key check", () => {
    // A plan whose api-key preset carries no verify contract is not a route.
    const plan = connectPlan("clay");
    expect(plan?.methods.some((method) => method.kind === "api-key")).toBe(
      false,
    );
    expect(compiledApiKeyRoute("clay")).toBe(false);
  });

  it("distinguishes a never-activated runtime from a withdrawn one", () => {
    resetNativeConnectorDrivers();
    // Never activated: no withdrawal history, the compiled contract stands.
    expect(nativeConnectorWithdrawn("api-key")).toBe(false);
    const release = registerNativeConnectorDriver("api-key", driver);
    expect(nativeConnectorWithdrawn("api-key")).toBe(false);
    release();
    // The owning capability gave the road back: withdrawn until it returns.
    expect(nativeConnectorWithdrawn("api-key")).toBe(true);
    registerNativeConnectorDriver("api-key", driver);
    expect(nativeConnectorWithdrawn("api-key")).toBe(false);
    resetNativeConnectorDrivers();
  });
});
