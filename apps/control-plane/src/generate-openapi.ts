import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildOpenApiDocument } from "./openapi.js";

// Schema generation is not a runtime deploy — allow local/CI defaults.
process.env.OPENSESAME_ALLOW_DEV_DEFAULTS ??= "true";

const config = loadConfig();
const doc = buildOpenApiDocument(config);
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../openapi.json");
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`Wrote ${out}`);
