/**
 * Run: node --experimental-strip-types --test .deepsec/deepsec-headless-agent-prompts.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { register } = await import("node:module");
register(
  "data:text/javascript,export async function resolve(s,c,next){" +
    "if(s.endsWith('.js')){try{return await next(s.replace(/\\.js$/,'.ts'),c);}catch{}}" +
    "return next(s,c);}",
);

const { parseInvestigateResults } = await import("./deepsec-headless-agent-prompts.ts");

test("parseInvestigateResults salvages JSON array after prose preamble", () => {
  const batch = [{ filePath: "apps/x.ts", candidates: [] }];
  const text =
    'I\'ll review the file first.\n\n```json\n[{"filePath":"apps/x.ts","findings":[]}]\n```';
  const { results } = parseInvestigateResults(text, batch);
  assert.equal(results.length, 1);
  assert.equal(results[0].filePath, "apps/x.ts");
  assert.deepEqual(results[0].findings, []);
});
