/**
 * WAL-B03/B05 in a real browser, now that the product has no demo control.
 *
 * Wallet › Spending passes used to carry an "Issue demo lease" button that
 * proposed a forged assurance label, an expired window and a replayed
 * assertion, and printed the refusals. bcd8d7c3 removed it — a word-verb
 * demo control is not a person's road (DESIGN.md) — and no agent surface
 * accepts a proof, so no click can reach those refusals any more.
 *
 * The probe keeps the claim a browser claim rather than a jsdom one: the
 * product's lease module is bundled from source and run in Chromium on the
 * static origin, with the page's own WebCrypto and localStorage. It runs on a
 * static JSON document of that origin, so the app never boots beside it and
 * nothing it stores is read by the app under test.
 */

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const GLOBAL = "__walletLeaseProbe";

/** esbuild is app-core's own dev dependency (its bare-isolate test uses it). */
async function bundle() {
  const require = createRequire(join(root, "packages/app-core/package.json"));
  const { build } = require("esbuild");
  const result = await build({
    entryPoints: [join(here, "lease-probe-entry.mjs")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: GLOBAL,
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild emitted nothing for the lease probe");
  return output.text;
}

/**
 * Run the probe in a new page of `context`, on `${origin}${base}`'s runtime
 * config document, and return each attempt's outcome.
 */
export async function runLeaseProbe(context, origin, base) {
  const code = await bundle();
  const page = await context.newPage();
  try {
    await page.goto(`${origin}${base}os-runtime-config.json`);
    return await page.evaluate(
      `${code}\n${GLOBAL}.runLeaseProbe(${JSON.stringify(base)})`,
    );
  } finally {
    await page.close();
  }
}
