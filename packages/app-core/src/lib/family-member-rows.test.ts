import { describe, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { catalogProvider } from "./connector-catalog.js";

/**
 * Google Drive and Microsoft 365 are members of the Google and Microsoft API
 * families. Their researched OAuth presets name no provider, and Vercel's
 * registry does not list them, so only a catalog row can (ADR 0139).
 */
describe("the family members a researched preset alone describes", () => {
  it.each([
    ["google-drive", "Google Drive", "storage"],
    ["m365", "Microsoft 365", "productivity"],
  ])(
    "%s is a catalog row the plan takes its name from",
    (id, name, category) => {
      const row = catalogProvider(id);
      expect(row, id).toMatchObject({
        displayName: name,
        category,
        authKind: "oauth2_authorization_code",
      });
      expect(connectPlan(id), id).toMatchObject({ name, category });
    },
  );
});
