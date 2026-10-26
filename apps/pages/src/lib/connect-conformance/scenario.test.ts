// @vitest-environment node
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { describe, expect, it } from "vitest";
import { VERIFY_TARGETS } from "../../../server/connect-verify-targets.generated.mjs";
import { verifyWithToken } from "../../../server/connect-verify.mjs";
import { CONFORMANCE_ACCOUNT } from "./provider-emulator.js";
import { scenario } from "./scenario.js";

describe("Asana current-user conformance responses", () => {
  it.each(["api-key", "oauth"] as const)(
    "%s preserves the account inside the documented data object",
    async (method) => {
      const plan = connectPlan("asana");
      if (!plan) throw new Error("The actual Asana plan is required");
      const { profile } = scenario(plan, method);
      const target =
        VERIFY_TARGETS.asana[method === "api-key" ? "apiKey" : "oauth"];
      expect(target.url).toBe("https://app.asana.com/api/1.0/users/me");
      expect(target.accountField).toBe("data.name");
      if (method === "api-key") expect(target.requiredFields).toContain("data");
      expect(profile.verify?.reply).toEqual({
        data: { name: CONFORMANCE_ACCOUNT },
      });
      const verified = await verifyWithToken(
        target,
        "synthetic-asana-token",
        async () => Response.json(profile.verify?.reply),
      );
      expect(verified).toEqual({
        status: 200,
        ok: true,
        account: CONFORMANCE_ACCOUNT,
      });
    },
  );
});
