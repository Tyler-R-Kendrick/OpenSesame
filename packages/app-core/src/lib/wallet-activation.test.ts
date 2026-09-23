import { describe, expect, it } from "vitest";
import {
  adapterProductionEnabled,
  temporaryCardIssuanceAvailable,
} from "./wallet-activation.js";

describe("wallet activation flags", () => {
  it("cannot promote local_execution_verified or blocked adapters via config/UI", () => {
    expect(
      adapterProductionEnabled({
        evidenceStatus: "local_execution_verified",
        configFlag: true,
        uiToggle: true,
      }),
    ).toBe(false);
    expect(
      adapterProductionEnabled({
        evidenceStatus: "blocked",
        configFlag: true,
        uiToggle: true,
      }),
    ).toBe(false);
    expect(
      adapterProductionEnabled({
        evidenceStatus: "target_deployment_verified",
        configFlag: true,
        uiToggle: true,
      }),
    ).toBe(false);
  });

  it("cannot unlock temporary-card issuance with a boolean", () => {
    expect(
      temporaryCardIssuanceAvailable({
        issuerAdapterReady: true,
        configUnlock: true,
      }),
    ).toBe(false);
  });
});
