import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repoRoot = process.cwd();
const { createHarness } = await import(
  pathToFileURL(
    path.join(repoRoot, "apps/pages/scripts/lib/static-origin-harness.mjs"),
  ).href
);
const { doorGuest } = await import(
  pathToFileURL(path.join(repoRoot, "apps/pages/scripts/lib/front-door.mjs"))
    .href
);
const { expect } = createRequire(
  path.join(repoRoot, "apps/pages/package.json"),
)("@playwright/test");
const out =
  process.env.PWA_GITHUB_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.PAGES_CAPTURE_PHASE;
if (!["before", "after"].includes(phase)) throw Error("phase required");
const dist = process.env.PAGES_VERIFY_DIST;
if (!dist)
  throw Error(
    "PAGES_VERIFY_DIST must identify the corresponding frozen production build",
  );
fs.mkdirSync(path.join(out, "raw", phase), { recursive: true });
const origin = "https://tyler-r-kendrick.github.io";
const base = "/OpenSesame/";
const files = [];
function inventory(dir, root = dir) {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) inventory(file, root);
    else
      files.push({
        path: path.relative(root, file),
        sha256: createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      });
  }
}
inventory(dist);
const distInventorySha256 = createHash("sha256")
  .update(JSON.stringify(files))
  .digest("hex");
const h = createHarness({ dist, origin, base, out });
const browser = await h.launch({ args: ["--no-sandbox"] });
const browserVersion = browser.version();
const measurements = [];
const requests = [];
async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, base + route);
}
async function revealStatusDescription(status, width) {
  if (width === 390) await status.tap();
  else await status.hover();
}
async function measured(page, width, step) {
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
    coarse: matchMedia("(pointer:coarse)").matches,
  }));
  const controls = await page
    .locator(
      ".conn-settings input:visible, .conn-settings select:visible, .conn-settings button:visible",
    )
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          tag: n.tagName,
          label:
            n.getAttribute("aria-label") ??
            n.labels?.[0]?.innerText ??
            n.innerText,
          type: n.getAttribute("type"),
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      }),
    );
  const statuses = await page.locator(".status-mark").evaluateAll((nodes) =>
    nodes.map((n) => ({
      tone: [...n.classList]
        .find((c) => c.startsWith("status-mark--"))
        ?.slice(13),
      label: n.getAttribute("aria-label"),
    })),
  );
  const picker = page.getByLabel("Connection method", { exact: true });
  const row = {
    width,
    height: 900,
    step,
    overflow,
    controls,
    statuses,
    pickerCount: await picker.count(),
    createButtonCount: await page
      .getByRole("button", { name: "Create GitHub App", exact: true })
      .count(),
    connectHeadingCount: await page
      .getByRole("heading", { name: /Connect$/ })
      .count(),
    docsHref: await page
      .getByRole("link", { name: "Docs", exact: true })
      .getAttribute("href"),
    url: page.url(),
  };
  if (await picker.count()) {
    row.method = await picker.inputValue();
    row.options = await picker.locator("option").allTextContents();
  }
  measurements.push(row);
  h.check(
    !overflow.overflow,
    `${width} ${step}: no horizontal document overflow`,
  );
  h.check(
    overflow.coarse === (width === 390),
    `${width} ${step}: pointer mode matches device`,
  );
  h.check(
    row.connectHeadingCount === 1,
    `${width} ${step}: exactly one Connect heading`,
  );
  await page.screenshot({
    path: path.join(out, "raw", phase, `${width}-${step}.png`),
    fullPage: false,
  });
  fs.writeFileSync(
    path.join(out, "raw", phase, `${width}-${step}.txt`),
    await page.locator("body").innerText(),
  );
  return row;
}
try {
  for (const width of [1280, 390]) {
    const { page, context } = await h.newPage(browser, {
      device: { isMobile: width === 390, hasTouch: width === 390 },
    });
    await page.setViewportSize({ width, height: 900 });
    page.on("request", (r) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(r.url()).origin === origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin)
        requests.push({ step: h.step(), method: r.method(), url: r.url() });
    });
    page.on("requestfailed", (r) =>
      h.record(
        "REQUEST-FAILED",
        `${r.method()} ${r.url()} ${r.failure()?.errorText}`,
      ),
    );
    h.setStep(`${phase}-${width}-boot`);
    await page.goto(origin + base, { waitUntil: "networkidle" });
    await doorGuest(page).click();
    await visit(page, "settings/features");
    const connections = page.getByRole("switch", {
      name: "Connections",
      exact: true,
    });
    await connections.waitFor();
    if ((await connections.getAttribute("aria-checked")) !== "true")
      await connections.click();
    await expect(connections).toHaveAttribute("aria-checked", "true");
    await visit(page, "settings/integrations");
    await page
      .getByRole("heading", { name: "Integrations", exact: true })
      .waitFor();
    await visit(page, "settings/connections/github");
    await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
    await page.waitForTimeout(350);
    h.setStep(`${phase}-${width}-default`);
    const initial = await measured(page, width, "default");
    const picker = page.getByLabel("Connection method", { exact: true });
    if (phase === "before") {
      h.check(
        initial.pickerCount === 0,
        `${width}: baseline has no App method selector`,
      );
      h.check(
        initial.createButtonCount === 0,
        `${width}: baseline has no Create App action`,
      );
      h.check(
        await page
          .getByLabel("GitHub personal access token", { exact: true })
          .isVisible(),
        `${width}: baseline PAT form is visible`,
      );
    } else {
      h.check(initial.method === "app", `${width}: App selected by default`);
      h.check(
        JSON.stringify(initial.options) ===
          JSON.stringify(["GitHub App", "Personal access token"]),
        `${width}: App is first method`,
      );
      h.check(
        initial.createButtonCount === 1,
        `${width}: native App creation is reachable`,
      );
      h.check(
        initial.docsHref === "https://docs.github.com/en/apps",
        `${width}: header docs point to GitHub Apps`,
      );
      await picker.selectOption("token");
      const token = page.getByLabel("GitHub personal access token", {
        exact: true,
      });
      await token.fill("draft-browser-test");
      h.setStep(`${phase}-${width}-token`);
      const tokenRow = await measured(page, width, "token");
      h.check(
        await token.isVisible(),
        `${width}: native token form remains usable`,
      );
      h.check(
        tokenRow.createButtonCount === 0,
        `${width}: hidden App action is absent from accessible tree`,
      );
      await picker.selectOption("app");
      await picker.selectOption("token");
      h.check(
        (await token.inputValue()) === "draft-browser-test",
        `${width}: token draft survives App/token switches`,
      );
      await token.fill("");
      for (const marker of ["registered", "installed"]) {
        h.setStep(`${phase}-${width}-${marker}`);
        await visit(page, "settings/integrations");
        await page
          .getByRole("heading", { name: "Integrations", exact: true })
          .waitFor();
        await visit(page, `settings/connections/github?github_app=${marker}`);
        await page
          .getByRole("heading", { name: "GitHub", exact: true })
          .waitFor();
        await expect(page).not.toHaveURL(new RegExp(`github_app=${marker}`));
        const error = page.locator(".conn-settings > .status-mark--err");
        await error.waitFor();
        await revealStatusDescription(error, width);
        const row = await measured(page, width, marker);
        row.queryRemoved = await page.evaluate(
          () => !new URLSearchParams(location.search).has("github_app"),
        );
        const success = row.statuses.filter(
          (s) => s.tone === "ok" && /GitHub App/i.test(s.label ?? ""),
        );
        row.successNoticeCount = success.length;
        row.errorNoticeCount = row.statuses.filter(
          (s) =>
            s.tone === "err" &&
            /GitHub App registration could not be verified/i.test(
              s.label ?? "",
            ),
        ).length;
        h.check(
          success.length === 0,
          `${width} ${marker}: forged marker does not report App success`,
        );
        h.check(
          row.errorNoticeCount === 1,
          `${width} ${marker}: callback reports actual verification failure`,
        );
        h.check(
          row.queryRemoved,
          `${width} ${marker}: callback marker removed`,
        );
        h.check(
          (await page.getByTestId("github-app-presence").count()) === 0,
          `${width} ${marker}: no fabricated App state`,
        );
        h.check(
          (await page
            .locator(".conn-settings__head .status-mark--ok")
            .count()) === 0,
          `${width} ${marker}: header does not claim connected`,
        );
      }
    }
    await context.close();
  }
} catch (error) {
  h.failures.push(`${h.step()}: ${error.stack ?? error}`);
  console.error(error);
} finally {
  await browser.close();
}
for (const row of h.log.filter((r) =>
  [
    "PAGE-ERROR",
    "console-error",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "LOOPBACK-REQUEST",
    "REQUEST-FAILED",
  ].includes(r.kind),
))
  h.failures.push(`${row.kind}: ${row.detail}`);
h.check(
  requests.length === 0,
  "No external/provider HTTP requests without configured credentials",
);
const manifest = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "source-manifest.json",
);
const sourceManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
const receipt = {
  phase,
  dist,
  browserVersion,
  distInventorySha256,
  distFiles: files,
  compiledParentCommit: sourceManifest.parent,
  compiledSourceTree:
    phase === "after" ? "4595630ce41c148925a359f3f6c74929846e5bc2" : null,
  overlayFiles: phase === "after" ? sourceManifest.files : [],
  sourceDescription:
    phase === "before"
      ? "Clean immutable parent worktree"
      : "Parent plus frozen six-file entry UI overlay",
  overlayManifestSha256:
    phase === "after"
      ? createHash("sha256").update(fs.readFileSync(manifest)).digest("hex")
      : null,
  indexSha256: createHash("sha256")
    .update(fs.readFileSync(path.join(dist, "index.html")))
    .digest("hex"),
  measurements,
  requests,
  checks: h.log.filter((r) => r.kind === "PASS"),
  log: h.log,
  failures: h.failures,
};
fs.writeFileSync(
  path.join(out, `${phase}-metrics.json`),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    phase,
    checks: receipt.checks.length,
    failures: h.failures,
    measurements: measurements.length,
    requests: requests.length,
  }),
);
if (h.failures.length) process.exitCode = 1;
