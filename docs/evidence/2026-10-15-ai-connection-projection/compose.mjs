import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = process.cwd();
const { composeSheet } = await import(
  pathToFileURL(path.join(repo, "apps/pages/scripts/lib/visual-evidence.mjs"))
    .href
);
const { chromium } = createRequire(path.join(repo, "apps/pages/package.json"))(
  "@playwright/test",
);
const root =
  process.env.PWA_AI_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(
  fs.readFileSync(path.join(root, "before-metrics.json")),
);
const after = JSON.parse(
  fs.readFileSync(path.join(root, "after-metrics.json")),
);
if (before.failures.length || after.failures.length)
  throw Error("Both real-build journeys must pass");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM,
  headless: true,
  args: ["--no-sandbox"],
});
function header(receipt, width) {
  return receipt.measurements
    .find((r) => r.width === width && r.step === "verified-save")
    .statuses.find((s) => s.inHeader);
}
try {
  for (const width of [1280, 390]) {
    const old = header(before, width);
    const next = header(after, width);
    await composeSheet(
      {
        newPage: (options) =>
          browser.newPage({ ...options, deviceScaleFactor: 1 }),
      },
      {
        shot: `${width}-ai-projection`,
        width,
        title: `Verified AI connection header — ${width}px`,
        caption:
          "Actual matched loopback_development builds and independently validating HTTP/CORS fixture. A real PIN vault owns the saved Token. NVIDIA is the configured provider preset; no hosted vendor account is claimed.",
        rows: [
          {
            shot: `${width}-verified-save`,
            heading: "Authenticated Test and Save completed",
            before: `Actual header: ${old.label} (${old.tone}); Test + Save each completed real inference`,
            after: `Actual header: ${next.label} (${next.tone}); Test + Save each completed real inference`,
          },
          {
            shot: `${width}-denied-test`,
            heading: "Invalid credential remains an actual failure",
            before:
              "Wrong fixture key: one real HTTP401, visible rejection, no saved inference workspace",
            after:
              "Wrong fixture key: one real HTTP401, visible rejection, no saved inference workspace",
          },
          {
            shot: `${width}-saved-inference`,
            heading: "Saved vault-owned key performs another inference",
            before:
              "Actual fixture answer returned through the saved connection despite the stale header refusal",
            after:
              "Actual fixture answer returned through the same saved-connection operation",
          },
        ],
      },
      {
        before: path.join(root, "raw/before"),
        after: path.join(root, "raw/after"),
      },
      root,
    );
  }
} finally {
  await browser.close();
}
