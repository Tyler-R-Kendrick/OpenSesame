// One walk, run against a build's dist: seal a vault, add Browser-local IAM,
// register a local application, open its "Application registration" editor
// and photograph the row at phone and desktop width. Facts come from the
// browser, never from the source.
//   node walk-registration.mjs <dist> <outDir>
import fs from "node:fs";
import path from "node:path";

const REPO = new URL("../../../apps/pages/scripts", import.meta.url).pathname;
const { createHarness } = await import(`${REPO}/lib/static-origin-harness.mjs`);
const { addCapabilities, openSection, sealWithPassword } = await import(
  `${REPO}/lib/pages-journey.mjs`
);

const [dist, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = "/OpenSesame/";
const { launch, newPage, failures, log } = createHarness({
  dist,
  origin: ORIGIN,
  base: BASE,
  out,
});

const NAME = "OpenSesame";
const facts = {};
const browser = await launch();
try {
  const { page } = await newPage(browser);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await addCapabilities(page, [
    "External connectors",
    "Access authority",
    "Browser-local IAM",
    "Directory provisioning",
  ]);
  await openSection(page, "identity/");
  const region = page.getByRole("region", {
    name: "Local applications",
    exact: true,
  });
  await page.getByRole("tab", { name: "Applications", exact: true }).click();
  await region.waitFor({ timeout: 15000 });
  const row = region
    .getByRole("listitem")
    .filter({ hasText: "local_00000000-0000-4000-8000-000000000002" });
  await row.waitFor({ timeout: 10000 });
  await row.locator("summary", { hasText: "Application registration" }).click();
  const org = row.getByRole("combobox", { name: "Organization", exact: true });
  await org.waitFor({ timeout: 8000 });
  await org.selectOption({ index: 1 });
  await row
    .getByRole("textbox", { name: "Redirect URIs (one per line)", exact: true })
    .fill("https://rp.example.test/callback");
  await row
    .getByRole("button", { name: "Save registration", exact: true })
    .click();
  await row
    .getByText("Registered locally. Access still requires authorization.", {
      exact: true,
    })
    .waitFor({ timeout: 10000 });

  for (const [label, width, height] of [
    ["390", 390, 844],
    ["1280", 1280, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(700);
    await row.locator("summary").evaluate((n) => {
      let el = n.parentElement;
      while (el && el.scrollHeight <= el.clientHeight + 1)
        el = el.parentElement;
      n.scrollIntoView({ block: "start", behavior: "instant" });
      (el ?? document.scrollingElement).scrollBy(0, -140);
    });
    await page.waitForTimeout(500);
    const measured = await row.evaluate((node) => {
      const buttons = [...node.querySelectorAll("button")].map((b) =>
        (b.textContent || "").trim(),
      );
      const summary = node.querySelector("summary");
      const details = node.querySelector("details");
      const org = [...node.querySelectorAll("label")].find((l) =>
        /^Organization/.test(l.textContent || ""),
      );
      const sum = summary?.getBoundingClientRect();
      const o = org?.getBoundingClientRect();
      return {
        visualButton: buttons.includes("Visual"),
        sourceButton: buttons.includes("Source"),
        modeGroup: !!node.querySelector('[aria-label="Editor representation"]'),
        sourceTextarea: !!node.querySelector("textarea[data-config-source]"),
        editorHeightPx: Math.round(
          details?.getBoundingClientRect().height ?? 0,
        ),
        summaryToOrganizationPx:
          sum && o ? Math.round(o.top - sum.bottom) : null,
      };
    });
    facts[label] = measured;
    await page.screenshot({
      path: path.join(out, `${label}-registration.png`),
    });
  }
  fs.writeFileSync(
    path.join(out, "facts.json"),
    JSON.stringify(facts, null, 2),
  );
  console.log(JSON.stringify(facts));
  if (failures.length) console.error(failures.join("\n"));
  const hard = log.filter((e) =>
    ["FAIL", "PAGE-ERROR", "LOOPBACK-REQUEST"].includes(e.kind),
  );
  if (hard.length) console.error(JSON.stringify(hard.slice(0, 5)));
} finally {
  await browser.close();
}
