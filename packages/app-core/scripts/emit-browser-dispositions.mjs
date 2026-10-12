/**
 * Compile the authored browser dispositions: why a provider has no browser road.
 *
 * The app ships what it says (the reason, its sources and where to go instead).
 * The evidence behind each row (the dated probes, the kind definitions) stays in
 * the spec for the tests and `pnpm audit:browser-dispositions`; a browser never
 * reads it, so it is not in the bundle.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packJsonRows } from "./pack-json.mjs";

/** The part of the spec a browser reads. */
export function runtimeDispositions(spec) {
  if (spec.schema_version !== 1 || !Array.isArray(spec.dispositions))
    throw new Error("Invalid browser dispositions source");
  return {
    schema_version: spec.schema_version,
    audited_origin: spec.audited_origin,
    checked_date: spec.checked_date,
    dispositions: spec.dispositions.map(({ probes: _probes, ...row }) => row),
  };
}

export function renderBrowserDispositions(spec) {
  const { rows, dictionary } = packJsonRows([
    JSON.stringify(runtimeDispositions(spec)),
  ]);
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
