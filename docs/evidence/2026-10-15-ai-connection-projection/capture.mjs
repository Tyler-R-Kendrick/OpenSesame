import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = process.cwd();
const helper = (name) =>
  pathToFileURL(path.join(repo, "apps/pages/scripts/lib", name)).href;
const { createHarness } = await import(helper("static-origin-harness.mjs"));
const { createAiConnectionHttpFixture, AI_FIXTURE_KEY, AI_FIXTURE_MODEL } =
  await import(helper("ai-connection-http-fixture.mjs"));
const { startIdentityAppServer } = await import(
  helper("identity-browser-server.mjs")
);
const { sealWithPin, addCapabilities } = await import(
  helper("pages-journey.mjs")
);
const { newBackendPage, enableBackendConnections, visitBackendRoute } =
  await import(helper("secret-backend-browser.mjs"));
const { expect } = createRequire(path.join(repo, "apps/pages/package.json"))(
  "@playwright/test",
);
const out =
  process.env.PWA_AI_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.PAGES_CAPTURE_PHASE;
const dist = process.env.PAGES_VERIFY_DIST;
if (!["before", "after"].includes(phase) || !dist)
  throw Error("PAGES_CAPTURE_PHASE and PAGES_VERIFY_DIST required");
fs.mkdirSync(path.join(out, "raw", phase), { recursive: true });
const origin = "http://localhost:41911";
const base = "/OpenSesame/";
const h = createHarness({ dist, origin, base, out });
const measurements = [];
const expectedRejections = [];
const network = [];
let browser;
let fixture;
let app;
let negative = false;
let negative401Seen = false;
let browserVersion = null;
function record(kind, detail) {
  if (
    negative &&
    kind === "HTTP-ERROR" &&
    detail === `401 ${fixture.baseUrl}/chat/completions`
  )
    negative401Seen = true;
  const expected =
    negative &&
    ((kind === "HTTP-ERROR" &&
      detail === `401 ${fixture.baseUrl}/chat/completions`) ||
      (kind === "console-error" &&
        detail.startsWith(
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
        )) ||
      (kind === "network-failure" &&
        negative401Seen &&
        detail === `net::ERR_ABORTED: ${fixture.baseUrl}/chat/completions`));
  h.record(expected ? `EXPECTED-${kind}` : kind, detail);
}
async function snap(page, width, step) {
  const data = await page.locator(".conn-settings").evaluate((root) => ({
    url: location.href,
    heading: root.querySelector(
      ".conn-settings__head h2,.conn-settings__head h1",
    )?.innerText,
    statuses: [...root.querySelectorAll(".status-mark")].map((n) => ({
      label: n.getAttribute("aria-label"),
      tone: [...n.classList]
        .find((c) => c.startsWith("status-mark--"))
        ?.slice(13),
      inHeader: !!n.closest(".conn-settings__head"),
    })),
    overflow: {
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    },
    coarse: matchMedia("(pointer:coarse)").matches,
    controls: [...root.querySelectorAll("input,select,button")]
      .filter((n) => n.getClientRects().length)
      .map((n) => {
        const r = n.getBoundingClientRect();
        return {
          label:
            n.labels?.[0]?.textContent?.trim() ??
            n.getAttribute("aria-label") ??
            n.textContent,
          tag: n.tagName,
          type: n.type,
          disabled: n.disabled,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      }),
  }));
  measurements.push({ width, height: 900, step, ...data });
  h.check(
    data.overflow.document === data.overflow.viewport,
    `${width} ${step}: no horizontal document overflow`,
  );
  h.check(
    data.coarse === (width === 390),
    `${width} ${step}: actual desktop/touch pointer mode`,
  );
  await page.screenshot({
    path: path.join(out, "raw", phase, `${width}-${step}.png`),
    fullPage: false,
  });
  fs.writeFileSync(
    path.join(out, "raw", phase, `${width}-${step}.txt`),
    await page.locator(".conn-settings").innerText(),
  );
  return data;
}
try {
  app = await startIdentityAppServer(dist, origin, base);
  fixture = await createAiConnectionHttpFixture({ appOrigin: origin });
  browser = await h.launch({ args: ["--no-sandbox"] });
  browserVersion = browser.version();
  for (const width of [1280, 390]) {
    h.setStep(`${phase}-${width}-real-vault`);
    const { page, context } = await newBackendPage(browser, {
      width,
      origin,
      providers: [fixture.origin],
      record,
    });
    page.on("request", (r) =>
      network.push({
        step: h.step(),
        method: r.method(),
        url: r.url(),
        type: r.resourceType(),
      }),
    );
    try {
      await page.goto(origin + base, { waitUntil: "networkidle" });
      await sealWithPin(page);
      await enableBackendConnections(page, base);
      await addCapabilities(page, ["On-device model"]);
      await visitBackendRoute(page, base, "settings/connections/nvidia");
      const form = page.getByRole("form", {
        name: "AI connection configuration",
        exact: true,
      });
      await form.waitFor();
      const name = `NVIDIA browser fixture ${width}`;
      await page.getByLabel("Connection name", { exact: true }).fill(name);
      await page
        .getByLabel("API family", { exact: true })
        .selectOption("openai_chat");
      await page
        .getByLabel("API base URL", { exact: true })
        .fill(fixture.baseUrl);
      await page.getByLabel("Model ID", { exact: true }).fill(AI_FIXTURE_MODEL);
      await page
        .getByLabel("Authentication", { exact: true })
        .selectOption("api-key");
      await page
        .getByLabel("API key", { exact: true })
        .fill("deliberately-wrong-fixture-key");
      h.setStep(`${phase}-${width}-denied-test`);
      negative = true;
      negative401Seen = false;
      const failedStart = fixture.requests.length;
      await page
        .getByRole("button", { name: "Test AI connection", exact: true })
        .click();
      const failure = form.getByRole("img", {
        name: "The AI service refused the credential or its permissions.",
        exact: true,
      });
      await failure.waitFor();
      await page.waitForTimeout(200);
      const denied = fixture.requests.slice(failedStart);
      h.check(
        denied.length === 1 && !denied[0].authenticated,
        `${width}: wrong key made one actual rejected inference request`,
      );
      expectedRejections.push(denied[0].id);
      h.check(
        (await page
          .getByRole("region", { name: "Model inference", exact: true })
          .count()) === 0,
        `${width}: rejected probe does not create a saved inference workspace`,
      );
      await failure.scrollIntoViewIfNeeded();
      if (width === 390) await failure.tap();
      else await failure.hover();
      await snap(page, width, "denied-test");
      negative = false;
      h.setStep(`${phase}-${width}-verified-save`);
      await page.getByLabel("API key", { exact: true }).fill(AI_FIXTURE_KEY);
      const positiveStart = fixture.requests.length;
      await page
        .getByRole("button", { name: "Test AI connection", exact: true })
        .click();
      await form
        .getByRole("img", { name: "Model inference verified", exact: true })
        .waitFor();
      h.check(
        fixture.requests.length === positiveStart + 1,
        `${width}: Test performs a real authenticated inference`,
      );
      await page
        .getByRole("button", { name: "Save AI connection", exact: true })
        .click();
      const region = page.getByRole("region", {
        name: "Model inference",
        exact: true,
      });
      await region.waitFor();
      await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
      const saved = fixture.requests.slice(positiveStart);
      h.check(
        saved.length === 2 &&
          saved.every(
            (r) =>
              r.authenticated &&
              r.path === "/custom/v1/chat/completions" &&
              r.family === "openai_chat" &&
              !r.stream,
          ),
        `${width}: Test and Save independently pass authenticated custom-endpoint inference`,
      );
      await page.evaluate(() => scrollTo(0, 0));
      const head = page.locator(".conn-settings__head .status-mark");
      await head.waitFor();
      if (width === 390) await head.tap();
      else await head.hover();
      const measured = await snap(page, width, "verified-save");
      const header = measured.statuses.filter((s) => s.inHeader);
      h.check(
        header.length === 1,
        `${width}: one actual provider header status`,
      );
      if (phase === "after")
        h.check(
          header[0].tone === "ok" && header[0].label === "Access verified",
          `${width}: verified canonical inference projects to verified header`,
        );
      h.setStep(`${phase}-${width}-saved-inference`);
      await region
        .getByLabel("Prompt", { exact: true })
        .fill(`NVIDIA saved endpoint browser evidence ${width}`);
      await region
        .getByRole("checkbox", { name: "Stream response", exact: true })
        .setChecked(false);
      const inferStart = fixture.requests.length;
      await region
        .getByRole("button", { name: "Send prompt", exact: true })
        .click();
      await expect(
        region.getByLabel("Model answer", { exact: true }),
      ).toHaveText("Fixture openai_chat answer");
      h.check(
        fixture.requests.length === inferStart + 1 &&
          fixture.requests.at(-1).authenticated,
        `${width}: saved connection performs actual inference with vault-owned token`,
      );
      await region.scrollIntoViewIfNeeded();
      await snap(page, width, "saved-inference");
      h.setStep(`${phase}-${width}-token-custody`);
      await visitBackendRoute(page, base, "vault?f=all");
      const tokenName = `AI API key · ${name}`;
      const token = page.getByRole("treeitem").filter({ hasText: tokenName });
      await expect(token).toHaveCount(1);
      await token.click();
      await page
        .getByRole("heading", { name: tokenName, exact: true })
        .waitFor();
      await page.getByRole("button", { name: /^Reveal [Tt]oken$/ }).click();
      await expect(
        page.getByText(AI_FIXTURE_KEY, { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /^Hide [Tt]oken$/ }).click();
      h.check(
        true,
        `${width}: retained key is an actual readable vault Token item`,
      );
      h.check(
        await page.evaluate(
          (secret) =>
            !JSON.stringify(Object.values(localStorage)).includes(secret),
          AI_FIXTURE_KEY,
        ),
        `${width}: fixture key absent from plaintext configuration storage`,
      );
    } catch (error) {
      await page.screenshot({
        path: path.join(out, `failure-${phase}-${width}.png`),
        fullPage: false,
      });
      throw error;
    } finally {
      negative = false;
      await context.close();
    }
  }
} catch (error) {
  h.failures.push(`${h.step()}: ${error.stack ?? error}`);
  console.error(error);
} finally {
  await browser?.close();
  await fixture?.close();
  await app?.close();
}
const errors = h.log.filter((r) =>
  [
    "PAGE-ERROR",
    "console-error",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "unexpected-external-request",
    "worker-network-error",
    "network-failure",
  ].includes(r.kind),
);
h.failures.push(...errors.map((r) => `${r.kind}: ${r.detail}`));
for (const error of fixture?.errors ?? [])
  if (!(error.status === 401 && expectedRejections.includes(error.id)))
    h.failures.push(
      `Unexpected fixture refusal ${error.id} HTTP${error.status}`,
    );
h.check(
  (fixture?.preflights.length ?? 0) > 0,
  "Actual browser CORS preflights reached independent HTTP fixture",
);
const result = {
  phase,
  dist,
  browserVersion,
  sourceParent: process.env.PWA_COMPILED_PARENT ?? null,
  sourceTree: process.env.PWA_COMPILED_TREE ?? null,
  sourceDescription: process.env.PWA_COMPILED_DESCRIPTION ?? null,
  indexSha256: createHash("sha256")
    .update(fs.readFileSync(path.join(dist, "index.html")))
    .digest("hex"),
  profile: "loopback_development",
  canonicalOrigin: origin,
  measurements,
  checks: h.log.filter((r) => r.kind === "PASS"),
  failures: h.failures,
  fixture: {
    requests: fixture?.requests,
    preflights: fixture?.preflights,
    errors: fixture?.errors,
    expectedRejectionIds: expectedRejections,
  },
  log: h.log,
  network,
  limits: [
    "Synthetic fixture account only; no hosted NVIDIA/vendor account claim.",
    "Actual production build and durable PIN vault; no credentials/configuration/DOM seeded.",
    "Real loopback HTTP/CORS; no provider request routing, browser extension, TLS relaxation or OpenSesame backend.",
    "Development local-network consent is granted through existing explicit Chrome permission helper.",
  ],
};
fs.writeFileSync(
  path.join(out, `${phase}-metrics.json`),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    phase,
    checks: result.checks.length,
    failures: h.failures,
    fixtureRequests: fixture?.requests.length,
    preflights: fixture?.preflights.length,
  }),
);
if (h.failures.length) process.exitCode = 1;
