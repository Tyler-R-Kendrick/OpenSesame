import { describe, expect, it } from "vitest";
import { envAssignments } from "../password-agent/env.js";
import { envNameFor, itemEnvTemplate } from "./item-references.js";

describe("an item's reference template", () => {
  it("names each variable from the item and the field, as a valid environment name", () => {
    expect(envNameFor("GitHub (work)", "API key")).toBe("GITHUB_WORK_API_KEY");
    expect(envNameFor("1st service", "token")).toBe("_1ST_SERVICE_TOKEN");
    expect(envNameFor("", "")).toBe("CREDENTIAL");
  });

  it("writes one reference-only line per field and keeps the names unique", () => {
    const text = itemEnvTemplate("Stripe", [
      { label: "Key", ref: "os://t/i/value" },
      { label: "Key", ref: "os://t/i/other" },
    ]);
    expect(text).toBe(
      "STRIPE_KEY=os://t/i/value\nSTRIPE_KEY_2=os://t/i/other\n",
    );
    expect(envAssignments(text)).toHaveLength(2);
  });

  it("is empty for an item with no references", () => {
    expect(itemEnvTemplate("Nothing", [])).toBe("\n");
  });
});
