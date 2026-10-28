import { describe, expect, it } from "vitest";
import {
  clearVaultResetRunsForTest,
  setVaultResetRunPhase,
  vaultResetRunFor,
} from "./vault-run-tracker.js";

describe("vault reset run tracker", () => {
  it("clears done runs and keeps active phases", () => {
    clearVaultResetRunsForTest();
    setVaultResetRunPhase("personal", "a", "in-progress", null);
    expect(vaultResetRunFor("personal", "a")?.phase).toBe("in-progress");
    setVaultResetRunPhase("personal", "a", "done", null);
    expect(vaultResetRunFor("personal", "a")).toBeNull();
  });
});
