/** Compile the authored browser dispositions: why a provider has no browser road, and the evidence. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packJsonRows } from "./pack-json.mjs";

export function renderBrowserDispositions(spec) {
  if (spec.schema_version !== 1 || !Array.isArray(spec.dispositions))
    throw new Error("Invalid browser dispositions source");
  const { rows, dictionary } = packJsonRows([JSON.stringify(spec)]);
  return [
    "/** Generated from spec/connectors/browser-dispositions.json; edit that source. */",
    'import { unpackGeneratedJson } from "./generated-json.js";',
    `const dictionary = ${JSON.stringify(dictionary.join("\n"))}.split("\\n");`,
    `export const BROWSER_DISPOSITIONS_JSON = unpackGeneratedJson(${JSON.stringify(rows[0])}, dictionary);`,
    "",
  ].join("\n");
}
const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const spec = JSON.parse(
    readFileSync(
      join(here, "../../../spec/connectors/browser-dispositions.json"),
      "utf8",
    ),
  );
  writeFileSync(
    join(here, "../src/lib/browser-dispositions.generated.ts"),
    renderBrowserDispositions(spec),
  );
}
