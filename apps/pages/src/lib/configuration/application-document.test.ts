import { describe, expect, it } from "vitest";
import {
  parseApplicationSource,
  registrationToYaml,
} from "./application-document.js";

const registration = {
  applicationId: "app-1",
  organizationId: "org-1",
  redirectUris: ["https://rp.example/callback"],
  scopes: ["openid"],
};

describe("application document", () => {
  it("round-trips registration YAML and keeps comments", () => {
    const yaml = registrationToYaml(registration);
    expect(yaml).toContain("Registration is not consent");
    const parsed = parseApplicationSource(yaml, "app-1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.redirectUris).toEqual([
        "https://rp.example/callback",
      ]);
    }
  });

  it("refuses to change application identity in source", () => {
    const yaml = registrationToYaml(registration).replace(
      "applicationId: app-1",
      "applicationId: app-2",
    );
    expect(parseApplicationSource(yaml, "app-1").ok).toBe(false);
  });
});
