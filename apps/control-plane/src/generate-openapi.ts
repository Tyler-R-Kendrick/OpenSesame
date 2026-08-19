import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildOpenApiDocument } from "./openapi.js";

// Schema generation is not a runtime deploy — snapshot the test/default surface,
// not whatever PORT/PUBLIC_URL happens to be in the operator's shell.
const config = loadConfig({
  OPENSESAME_ENV: "test",
  OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
});
const doc = buildOpenApiDocument(config);
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../openapi.json");
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`Wrote ${out}`);
