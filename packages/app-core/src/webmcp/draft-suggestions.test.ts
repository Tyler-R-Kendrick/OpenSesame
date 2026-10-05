import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerContributionForTest,
  resetContributionsForTest,
} from "../lib/contributions.js";
import { suggestItemMetadata } from "./draft-suggestions.js";

afterEach(() => {
  resetContributionsForTest();
});

describe("a WebMCP draft suggestion from the on-device model", () => {
  it("is refused when support.local-ai contributed nothing", async () => {
    await expect(
      suggestItemMetadata({
        action: "suggest",
        kind: "account",
        source: "browser",
      }),
    ).rejects.toThrow("on_device_model_not_enabled");
  });

  it("goes through what support.local-ai contributed", async () => {
    const suggest = vi.fn(async () => ({ name: "Mail", username: "ada" }));
    registerContributionForTest("item-draft-assist", {
      id: "on-device",
      order: 10,
      Suggestions: () => null,
      suggest,
    });
    await expect(
      suggestItemMetadata({
        action: "suggest",
        kind: "account",
        source: "browser",
        url: "https://mail.example",
      }),
    ).resolves.toMatchObject({ source: "browser", name: "Mail" });
    expect(suggest).toHaveBeenCalledWith(
      { typeId: "account", website: "https://mail.example" },
      expect.any(AbortSignal),
    );
  });

  it("hands the model the account type for the retired login name", async () => {
    const suggest = vi.fn(async () => ({ name: "Mail", username: "ada" }));
    registerContributionForTest("item-draft-assist", {
      id: "on-device",
      order: 10,
      Suggestions: () => null,
      suggest,
    });
    await suggestItemMetadata({
      action: "suggest",
      kind: "login",
      source: "browser",
    });
    expect(suggest).toHaveBeenCalledWith(
      { typeId: "account", website: undefined },
      expect.any(AbortSignal),
    );
  });

  it("still labels at random with no model at all", async () => {
    const labels = await suggestItemMetadata({
      action: "suggest",
      kind: "account",
    });
    expect(labels.source).toBe("random");
  });
});
