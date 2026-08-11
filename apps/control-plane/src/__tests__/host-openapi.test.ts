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

  it("keeps the strict connection schemas aligned with the runtime contract", () => {
    for (const fragment of [
      "            - catalog_unavailable",
      "        provenance_url: { type: string, format: uri }",
      "        catalog_revision: { type: string, minLength: 1 }",
      'items: { $ref: "#/components/schemas/ConfigurationFieldDef" }',
      'items: { $ref: "#/components/schemas/ConfiguredField" }',
      'configuration_set: { $ref: "#/components/schemas/Configuration" }',
      "        configuration_clear:",
      "          minProperties: 1",
      "          minItems: 1",
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
  });

  it("documents every protected connector operation's operator alternative", () => {
    const operations = [
      ["/providers", "get"],
      ["/integrations", "get"],
      ["/integrations", "post"],
      ["/integrations/{id}", "get"],
      ["/integrations/{id}", "patch"],
      ["/integrations/{id}", "delete"],
      ["/connections", "get"],
      ["/connections", "post"],
      ["/connections/{id}", "get"],
      ["/connections/{id}", "delete"],
      ["/connections/{id}/authorize", "post"],
      ["/connections/{id}/refresh", "post"],
      ["/connections/{id}/credential", "post"],
      ["/connections/{id}/bindings", "post"],
      ["/connections/{id}/bindings/{binding_id}", "delete"],
      ["/connections/{id}/events", "get"],
    ] as const;
    for (const [path, method] of operations) {
      const pathStart = hostOpenApi.indexOf(`  ${path}:`);
      const pathEnd = hostOpenApi.indexOf("\n  /", pathStart + 1);
      const pathBlock = hostOpenApi.slice(
        pathStart,
        pathEnd === -1 ? undefined : pathEnd,
      );
      const methodStart = pathBlock.indexOf(`    ${method}:`);
      const methodTail = pathBlock.slice(methodStart + 1);
      const nextMethod = methodTail.search(
        /\n {4}(get|post|patch|delete|put):/,
      );
      const methodBlock = pathBlock.slice(
        methodStart,
        nextMethod === -1 ? undefined : methodStart + 1 + nextMethod,
      );
      expect(methodBlock, `${method.toUpperCase()} ${path}`).toContain(
        "security: [{ HostBearer: [] }, { HostOperatorHeader: [] }]",
      );
    }
  });
});
