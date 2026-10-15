import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repoRoot = process.cwd();
const { composeSheet } = await import(
  pathToFileURL(
    path.join(repoRoot, "apps/pages/scripts/lib/visual-evidence.mjs"),
  ).href
);
const { chromium } = createRequire(
  path.join(repoRoot, "apps/pages/package.json"),
)("@playwright/test");
const root =
  process.env.PWA_GITHUB_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(
  fs.readFileSync(path.join(root, "before-metrics.json")),
);
const after = JSON.parse(
  fs.readFileSync(path.join(root, "after-metrics.json")),
);
if (before.failures.length || after.failures.length)
  throw Error("Both actual production build journeys must pass");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const width of [1280, 390]) {
    const old = before.measurements.find((r) => r.width === width);
    const next = after.measurements.find(
      (r) => r.width === width && r.step === "default",
    );
    await composeSheet(
      {
        newPage: (options) =>
          browser.newPage({ ...options, deviceScaleFactor: 1 }),
      },
      {
        shot: `${width}-github-entry`,
        width,
        title: `GitHub App configuration entry — ${width}px`,
        caption:
          "Actual production builds, same front-door guest journey with Connections enabled. The native GitHub App entry is now reachable first; personal access token configuration remains selectable. No GitHub account credentials were supplied.",
        rows: [
          {
            shot: `${width}-default`,
            heading: "Fresh GitHub integration",
            before: `No App selector or Create App action; ${old.connectHeadingCount} Connect heading; overflow ${old.overflow.document - old.overflow.viewport}px`,
            after: `App first; Create App action reachable; ${next.connectHeadingCount} Connect heading; overflow ${next.overflow.document - next.overflow.viewport}px`,
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
