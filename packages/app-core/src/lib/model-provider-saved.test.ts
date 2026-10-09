import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliveredModels,
  modelExchange,
  performInference,
  sendModelOperation,
} from "./hosted-inference.js";
import { savedModelRequests } from "./model-provider.js";

afterEach(() => vi.restoreAllMocks());
describe("synchronous model compatibility", () => {
  it("refuses execution and never reports delivery, even for a populated operation", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const operation = {
      ok: true as const,
      providerId: "anthropic",
      operation: "inference",
      action: { model: "claude" },
      secrets: { credential: "secret-key" },
    };
    expect(modelExchange("anthropic")).toEqual({
      ok: false,
      providerId: "anthropic",
    });
    expect(performInference("anthropic").ok).toBe(false);
    expect(sendModelOperation(operation).ok).toBe(false);
    expect(savedModelRequests([operation]).map((row) => row.ok)).toEqual([
      false,
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(deliveredModels()).toEqual([]);
  });
});
