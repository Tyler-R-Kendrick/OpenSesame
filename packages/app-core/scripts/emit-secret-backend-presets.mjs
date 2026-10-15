#!/usr/bin/env node
/** Emit browser secret backend partner presets from their shared protocol catalog. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    join(here, "../../../spec/connectors/secret-backend-presets.json"),
    "utf8",
  ),
);
const modes = new Set([
  "local",
  "file-import",
  "credential-management",
  "onepassword-sdk",
  "onepassword-connect",
  "bitwarden-api",
  "bitwarden-secrets",
  "infisical",
  "passwordstate",
]);
const ids = new Set();
for (const row of spec.providers) {
  if (ids.has(row.providerId))
    throw new Error(`Duplicate secret backend provider ${row.providerId}`);
  ids.add(row.providerId);
  if (
    !row.modes.length ||
    row.modes.some((mode) => !modes.has(mode)) ||
    !row.modes.includes(row.defaultMode)
  )
    throw new Error(`Invalid secret backend mode for ${row.providerId}`);
}
const output = `// Generated from spec/connectors/secret-backend-presets.json; do not edit.\nimport type { SecretBackendPreset } from "./presets.js";\nexport const SECRET_BACKEND_PRESETS: readonly SecretBackendPreset[] = ${JSON.stringify(spec.providers, null, 2)};\n`;
writeFileSync(
  join(here, "../src/lib/secret-backends/presets.generated.ts"),
  output,
);
