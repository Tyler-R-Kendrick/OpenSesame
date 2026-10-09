import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Run after the canonical production build; no provider or app state injection. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { nativeEnableConnections } from "./lib/native-browser-catalog-journey.mjs";
import { NATIVE_AUDITED_ADOBE_ADMISSION } from "./lib/native-browser-catalog-projection.mjs";
import { nativeExpectedFailures } from "./lib/native-browser-expected-failures.mjs";
import { routeNativeGitlabAuthority } from "./lib/native-browser-gitlab-authority.mjs";
import { nativeGitlabJourney } from "./lib/native-browser-gitlab-journey.mjs";
import { routeNativeMcpAuthority } from "./lib/native-browser-mcp-authority.mjs";
import { nativeMcpJourney } from "./lib/native-browser-public-journey.mjs";
import { sealWithPin } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { walk } from "./lib/verify-dist-checks.mjs";
import { verifyDist } from "./verify-capability-graph.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.EVIDENCE_DIST ?? path.resolve(here, "..", "dist");
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "work/native-public-protocol",
);
// The disclosed authority admits this self-hosted origin. Measured GH-origin
// denials remain production policy and are independently checked by core tests.
const origin = "https://self-host.example.org";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const callback = `${origin}${base}auth/native-connector.html`;
fs.mkdirSync(out, { recursive: true });
const { report: graph } = await verifyDist({ dist, base, expectAbsent: [] });
if (!graph.ok)
  throw new Error(
    "Production capability graph must pass before browser protocol verification.",
  );
const hash = createHash("sha256");
for (const file of walk(dist).sort())
  hash
    .update(path.relative(dist, file))
    .update("\0")
    .update(fs.readFileSync(file));
const provenance = {
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  distSha256: hash.digest("hex"),
  indexSha256: createHash("sha256")
    .update(fs.readFileSync(path.join(dist, "index.html")))
    .digest("hex"),
  graph: {
    ok: graph.ok,
    profile: graph.profile,
    violations: graph.violations,
    mismatches: graph.mismatches,
  },
};
fs.writeFileSync(
  path.join(out, "build-provenance.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
);
const harness = createHarness({ dist, origin, base, out });
harness.check(
  !NATIVE_AUDITED_ADOBE_ADMISSION.available,
  "measured GH-origin Adobe mandatory-header denial remains enforced; the disclosed protocol authority uses a separately admitted self-hosted origin",
);
const browser = await harness.launch();
const results = [];
const expectedFailures = [];
let page;
try {
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1366, height: 1000 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ]) {
    const current = await harness.newPage(browser, { device });
    page = current.page;
    const authority = await routeNativeMcpAuthority(
      current.context,
      harness,
      callback,
    );
    expectedFailures.push(nativeExpectedFailures(harness, page, authority));
    await page.goto(`${origin}${base}`);
    await sealWithPin(page);
    await nativeEnableConnections(page, base);
    results.push(
      await nativeMcpJourney(page, harness, authority, {
        base,
        out,
        label,
        callback,
      }),
    );
    const gitlab = await routeNativeGitlabAuthority(
      current.context,
      harness,
      callback,
    );
    expectedFailures.push(nativeExpectedFailures(harness, page, gitlab));
    results.push(
      await nativeGitlabJourney(page, harness, gitlab, {
        base,
        out,
        label,
        callback,
      }),
    );
    await current.context.close();
  }
} catch (error) {
  harness.failures.push(String(error));
  if (page && !page.isClosed()) {
    fs.writeFileSync(path.join(out, "failure.html"), await page.content());
    fs.writeFileSync(
      path.join(out, "failure.txt"),
      `${page.url()}\n${await page.locator("body").innerText()}`,
    );
    await page
      .screenshot({
        path: path.join(out, "failure.png"),
        animations: "disabled",
        timeout: 10_000,
      })
      .catch((captureError) =>
        harness.record("FAILURE-CAPTURE", String(captureError)),
      );
  }
} finally {
  await browser.close();
}
const hard = harness.log.filter(
  (entry) =>
    [
      "LOOPBACK-REQUEST",
      "HTTP-ERROR",
      "console-error",
      "PAGE-ERROR",
      "MISSING-ASSET",
    ].includes(entry.kind) &&
    expectedFailures.every((unexpected) => unexpected(entry)),
);
const hosted = harness.log.filter((entry) =>
  /api\.vercel\.com\/v1\/connect|\/api\/connect/.test(entry.detail),
);
fs.writeFileSync(
  path.join(out, "receipt.json"),
  `${JSON.stringify({ authority: "disclosed synthetic upstream HTTP protocol; no live credentials", provenance, results, failures: harness.failures, hard, hosted, checks: harness.log.filter((entry) => ["PASS", "FAIL"].includes(entry.kind)) }, null, 2)}\n`,
);
if (harness.failures.length || hard.length || hosted.length) {
  console.error(
    JSON.stringify({ failures: harness.failures, hard, hosted }, null, 2),
  );
  process.exitCode = 1;
} else
  console.log(
    `ALL NATIVE PUBLIC PROTOCOL CHECKS PASSED — ${harness.log.filter((entry) => entry.kind === "PASS").length} assertions`,
  );
