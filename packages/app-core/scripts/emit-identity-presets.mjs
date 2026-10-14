#!/usr/bin/env node
/** Emit shared partner identity definitions from the protocol source of truth. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    join(here, "../../../spec/connectors/identity-presets.json"),
    "utf8",
  ),
);
const ids = new Set();
for (const row of spec.providers) {
  if (ids.has(row.id)) throw new Error(`Duplicate identity provider ${row.id}`);
  ids.add(row.id);
  if (
    !row.protocols.length ||
    row.protocols.some(
      (protocol) =>
        !["oidc", "saml", "ldap", "better-auth", "supabase"].includes(protocol),
    )
  )
    throw new Error(`Invalid identity protocol for ${row.id}`);
}
const output = `// Generated from spec/connectors/identity-presets.json; do not edit.\nimport type { IdentityConnectionPreset } from "./identity-connections-presets.js";\nexport const IDENTITY_CONNECTION_PRESETS: readonly IdentityConnectionPreset[] = ${JSON.stringify(spec.providers, null, 2)};\n`;
writeFileSync(join(here, "../src/lib/identity-presets.generated.ts"), output);
