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
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
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
});
