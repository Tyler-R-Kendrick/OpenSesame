import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const target = resolve(root, "apps/pages/scripts/lib/live-join-pages.mjs");
let source = readFileSync(target, "utf8");
const importAt = 'import path from "node:path";';
const installAt = "    const sockets = [];";
assert.equal(source.split(importAt).length, 2);
assert.equal(source.split(installAt).length, 2);
source = source.replace(importAt, `${importAt}\nimport { observeBlobs } from "./blob-observation.mjs";`);
source = source.replace(installAt, `    await observeBlobs(made.context);\n${installAt}`);
copyFileSync(new URL("./blob-observation.mjs", import.meta.url), resolve(root, "apps/pages/scripts/lib/blob-observation.mjs"));
writeFileSync(target, source);
