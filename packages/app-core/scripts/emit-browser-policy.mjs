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

/** Preserve the fields consumed by the browser policy, leaving audit probes in the source. */
export function projectBrowserPolicy(policy) {
  if (policy.schema_version !== 1 || !Array.isArray(policy.rules))
    throw new Error("Invalid browser policy source");
  return {
    schema_version: policy.schema_version,
    audited_origin: policy.audited_origin,
    checked_date: policy.checked_date,
    qualification: policy.qualification,
    rules: policy.rules.map((rule) => ({
      provider_id: rule.provider_id,
      method: rule.method,
      origins: rule.origins,
      parameters: rule.parameters,
      reason: rule.reason,
      evidence_urls: rule.evidence_urls,
    })),
  };
}

export function renderRuntimeBrowserPolicy(policy) {
  const { rows, dictionary } = packJsonRows([
    JSON.stringify(projectBrowserPolicy(policy)),
  ]);
  return [
    "/** Generated from spec/connectors/browser-policy.json; edit that source. */",
    'import { unpackGeneratedJson } from "./generated-json.js";',
    `const dictionary = ${JSON.stringify(dictionary.join("\n"))}.split("\\n");`,
    `export const NATIVE_BROWSER_POLICY_RUNTIME_JSON = unpackGeneratedJson(${JSON.stringify(rows[0])}, dictionary);`,
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
  writeFileSync(
    join(here, "../src/lib/native-browser-policy.runtime.generated.ts"),
    renderRuntimeBrowserPolicy(policy),
  );
}
