import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonObject, readJsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { catalogProvider } from "./connector-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Every OAuth and API-key preset, each as the JSON object the spec holds. */
function presetRows(): JsonObject[] {
  const presets = readJsonObject(
    JSON.parse(
      readFileSync(
        join(here, "../../../../spec/connectors/connect-presets.json"),
        "utf8",
      ),
    ),
  );
  const rows: JsonObject[] = [];
  for (const group of ["oauth", "api_key"]) {
    const listed = presets?.[group];
    if (!Array.isArray(listed)) continue;
    for (const value of listed) {
      const row = readJsonObject(value);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/**
 * A preset says how to connect to a service. What the service is called and
 * where it belongs comes from Vercel's registry or the integration catalog,
 * so no target can name it differently (ADR 0139, ADR 0147 §1).
 */
describe("a researched Connect preset", () => {
  it("names no provider and no category of its own", () => {
    const rows = presetRows();
    expect(rows.length).toBeGreaterThan(100);
    const named = rows
      .filter((row) => "display_name" in row || "category" in row)
      .map((row) => row.service);
    expect(named).toEqual([]);
  });

  it("takes the catalog row's name and category", () => {
    for (const id of ["fal-ai", "higgsfield", "obsidian", "polar"]) {
      const row = catalogProvider(id);
      expect(row, id).toBeDefined();
      expect(connectPlan(id), id).toMatchObject({
        name: row?.displayName,
        category: row?.category,
      });
    }
  });
});
