import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allAuthorities } from "./policy.js";
import { connectorBridgeTable } from "./table.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("the host table", () => {
  it("is what the generator derives from the specs today (drift fails here)", async () => {
    // @ts-expect-error — a plain .mjs script with no declaration file
    const { renderTable } = await import("../scripts/emit-table.mjs");
    expect(readFileSync(join(here, "table.generated.ts"), "utf8")).toBe(
      renderTable(),
    );
    execFileSync("node", ["--check", join(here, "../scripts/emit-table.mjs")]);
  });

  it("names only literal hosts: no scheme, port, path, wildcard or template", () => {
    for (const row of connectorBridgeTable)
      for (const host of row.authorities)
        expect(host).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  it("covers the providers whose API-key check browsers refuse and no provider twice", () => {
    const ids = connectorBridgeTable.map((row) => row.providerId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "plivo",
      "sendgrid",
      "agentmail",
      "datadog",
      "stepfun",
      "crusoe",
    ])
      expect(ids).toContain(id);
    expect(allAuthorities(connectorBridgeTable)).toContain("api.plivo.com");
  });

  it("leaves out an MCP-only provider, whose server streams", () => {
    const ids = connectorBridgeTable.map((row) => row.providerId);
    expect(ids).not.toContain("zapier");
    expect(ids).not.toContain("airtable");
  });
});
