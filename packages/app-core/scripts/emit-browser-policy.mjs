/** Compile the authored browser-only route restrictions; hosted contracts stay separate. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packJsonRows } from "./pack-json.mjs";

export function renderBrowserPolicy(policy) {
  if (policy.schema_version !== 1 || !Array.isArray(policy.rules))
    throw new Error("Invalid browser policy source");
  const { rows, dictionary } = packJsonRows([JSON.stringify(policy)]);
  return [
    "/** Generated from spec/connectors/browser-policy.json; edit that source. */",
    'import { unpackGeneratedJson } from "./generated-json.js";',
    `const dictionary = ${JSON.stringify(dictionary.join("\n"))}.split("\\n");`,
    `export const NATIVE_BROWSER_POLICY_JSON = unpackGeneratedJson(${JSON.stringify(rows[0])}, dictionary);`,
    "",
  ].join("\n");
}
const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const policy = JSON.parse(
    readFileSync(
      join(here, "../../../spec/connectors/browser-policy.json"),
      "utf8",
    ),
  );
  writeFileSync(
    join(here, "../src/lib/native-browser-policy.generated.ts"),
    renderBrowserPolicy(policy),
  );
}
