import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hostOpenApi = readFileSync(
  new URL("../../../../api/openapi/openapi.yaml", import.meta.url),
  "utf8",
);

describe("Host organization authority OpenAPI", () => {
  it("documents organization-bound session and revocation claims", () => {
    for (const fragment of [
      "  /device/approve:",
      "  /sessions/revoke:",
      "security: [{ HostOperatorBearer: [] }, { HostOperatorHeader: [] }]",
      "organization_id: { type: string }",
      'organization_role: { $ref: "#/components/schemas/OrganizationRole" }',
      'session: { $ref: "#/components/schemas/HostSession" }',
      'project_id: { type: [string, "null"] }',
      'credential_handle: { type: [string, "null"] }',
      'context: { type: [string, "null"] }',
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
  });

  it("states the Host JSON device profile without claiming RFC 8628 wire compatibility", () => {
    expect(hostOpenApi).toContain("OpenSesame Host JSON protocol profile");
    expect(hostOpenApi).not.toContain("summary: Start RFC 8628");
  });

  it("documents organization-fenced tasks and receipt evidence", () => {
    for (const fragment of [
      "  /tasks:",
      "  /tasks/intents:",
      "  /tasks/invoke:",
      "  /receipts/{id}:",
      "  /receipts/{id}/verify:",
      'schema: { $ref: "#/components/schemas/InvocationReceipt" }',
      "Present on schema 3 receipts",
      "Identity `prn_<uuid>`",
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
  });

  it("documents every freeze-intent failure", () => {
    const freezeIntent = hostOpenApi
      .split("  /tasks/intents:")[1]
      ?.split("  /tasks/invoke:")[0];
    for (const status of ['"400"', '"403"', '"404"', '"429"', '"503"']) {
      expect(freezeIntent).toContain(status);
    }
  });
});
