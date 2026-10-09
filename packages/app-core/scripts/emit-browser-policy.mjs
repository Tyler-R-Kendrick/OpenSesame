/** Compile the authored browser-only route restrictions; hosted contracts stay separate. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function renderBrowserPolicy(policy) {
  if (policy.schema_version !== 1 || !Array.isArray(policy.rules))
    throw new Error("Invalid browser policy source");
  return [
    "/** Generated from spec/connectors/browser-policy.json; edit that source. */",
    `export const NATIVE_BROWSER_POLICY_JSON = ${JSON.stringify(JSON.stringify(policy))};`,
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
