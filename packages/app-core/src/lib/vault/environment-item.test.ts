import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  environmentSchemaFileName,
  parseEnvironmentAliases,
  renderEnvironmentSchemaItem,
  scanEnvironmentSchema,
} from "./environment-item.js";

const values = (schema: string, aliases = "") => ({
  environment: "production",
  schema,
  aliases,
});

describe("the Environment item schema", () => {
  it("names the generated file from the item and its environment", () => {
    expect(environmentSchemaFileName("Billing API", "production")).toBe(
      "Billing API.production.env.schema",
    );
    expect(environmentSchemaFileName("Billing/API", "Production")).toBe(
      "Billing-API.production.env.schema",
    );
    expect(environmentSchemaFileName("Billing", "prod!")).toBe("");
  });

  it("writes one @vaultItem binding above its key, never a value", () => {
    const result = renderEnvironmentSchemaItem(
      "Billing API",
      values(
        "# @sensitive @required\nDATABASE_URL=\n\n# @sensitive\nAPI_KEY=",
        "DATABASE_URL=Backend/Database URL",
      ),
    );
    expect(result.problems).toEqual([]);
    expect(result.file?.fileName).toBe("Billing API.production.env.schema");
    expect(result.file?.content).toContain(
      "# @vaultItem=Backend/Database URL\nDATABASE_URL=",
    );
    expect(result.file?.content).toContain("API_KEY=");
    expect(result.file?.content).not.toContain("DATABASE_URL=Backend");
  });

  it("lets an alias replace an older binding without duplicating it", () => {
    const result = renderEnvironmentSchemaItem(
      "Billing",
      values("# @vaultItem=Old/Path\nDATABASE_URL=", "DATABASE_URL=New/Path"),
    );
    expect(result.file?.content).toBe("# @vaultItem=New/Path\nDATABASE_URL=\n");
  });

  it("refuses an alias whose key is not in the schema", () => {
    const result = renderEnvironmentSchemaItem(
      "Billing",
      values("DATABASE_URL=", "API_KEY=Backend/Api Key"),
    );
    expect(result.file).toBeNull();
    expect(result.problems).toEqual([
      { field: "aliases", message: "API_KEY is not declared in the schema." },
    ]);
  });

  it("refuses duplicate keys, invalid lines and a bad environment", () => {
    const scan = scanEnvironmentSchema("API_KEY=\nAPI_KEY=\nnot a key");
    expect(scan.problems.map((entry) => entry.message)).toEqual([
      "API_KEY is declared more than once.",
      "Line 3 is not a key, comment, or blank line.",
    ]);
    expect(parseEnvironmentAliases("API_KEY").problems).toHaveLength(1);
    const result = renderEnvironmentSchemaItem("Billing", {
      environment: "prod!",
      schema: "API_KEY=",
      aliases: "",
    });
    expect(result.file).toBeNull();
    expect(result.problems[0]?.field).toBe("environment");
  });

  it("parses the generated file with the repo's pinned @env-spec parser", () => {
    const bridge = fileURLToPath(
      new URL(
        "../../../../env-spec-bridge/bin/opensesame-env-parse.mjs",
        import.meta.url,
      ),
    );
    const parser = fileURLToPath(
      new URL(
        "../../../../env-spec-bridge/node_modules/@env-spec",
        import.meta.url,
      ),
    );
    if (!existsSync(bridge) || !existsSync(parser)) {
      console.warn("env-spec bridge is not installed here; skipping the parse");
      return;
    }
    const result = renderEnvironmentSchemaItem(
      "Billing",
      values(
        "# @currentEnv=$APP_ENV @defaultRequired=false\n# ---\n\n# @sensitive @required\nDATABASE_URL=",
        "DATABASE_URL=Backend/Database URL",
      ),
    );
    if (!result.file) throw new Error("no generated schema");
    const dir = mkdtempSync(join(tmpdir(), "environment-item-"));
    const file = join(dir, result.file.fileName);
    writeFileSync(file, result.file.content);
    const parsed = JSON.parse(
      execFileSync(process.execPath, [bridge, file], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      }),
    );
    expect(parsed.items.map((item: { key: string }) => item.key)).toEqual([
      "DATABASE_URL",
    ]);
    expect(result.file.content).toContain("# @vaultItem=Backend/Database URL");
  });
});
