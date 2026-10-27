import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [phase, source, out] = process.argv.slice(2);
const moduleAt = (name) => import(pathToFileURL(path.join(source, name)));
const { createHarness } = await moduleAt(
  "apps/pages/scripts/lib/static-origin-harness.mjs",
);
const { sealWithPin, addCapabilities, lockVault } = await moduleAt(
  "apps/pages/scripts/lib/pages-journey.mjs",
);
fs.mkdirSync(out, { recursive: true });
const origin = "https://tyler-r-kendrick.github.io";
const harness = createHarness({
  dist: path.join(source, "apps/pages/dist"),
  origin,
  base: "/OpenSesame/",
  out,
});
const browser = await harness.launch({ args: ["--no-sandbox"] });
const results = [];
async function settleSupport(page) {
  const sheet = page.getByRole("dialog", { name: "Support", exact: true });
  await sheet.evaluate(async (node) => {
    const finite = node.getAnimations({ subtree: true }).filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime),
    );
    await Promise.all(finite.map((animation) => animation.finished));
  });
  assert.equal(await sheet.evaluate((node) => getComputedStyle(node).opacity), "1");
}
async function openSupport(page, atGate = false) {
  const direct = page.getByRole("button", { name: "Support", exact: true });
  if (atGate || (await direct.count())) await direct.first().click();
  else {
    await page
      .getByRole("button", { name: /^More —/ })
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "More", exact: true })
      .getByRole("button", { name: /^Help$/ })
      .click();
  }
  await page.getByRole("dialog", { name: "Support", exact: true }).waitFor();
  await settleSupport(page);
}
async function gateSnapshot(page, name) {
  const about = page.getByText("About this project", { exact: true });
  assert.equal(
    await about.count(),
    phase === "before" ? 1 : 0,
    `${name}: project gate control`,
  );
  if (phase === "before") await about.click();
  const links = page.locator(".unlock__notes-about-list a");
  assert.equal(
    await links.count(),
    phase === "before" ? 10 : 0,
    `${name}: gate project links`,
  );
  await page.screenshot({
    path: path.join(out, `${name}.png`),
    fullPage: true,
  });
  await openSupport(page, true);
  const sheet = page.getByRole("dialog", { name: "Support", exact: true });
  assert.equal(
    await sheet.getByText("About this project", { exact: true }).count(),
    0,
    `${name}: gate Support project control absent`,
  );
  assert.equal(
    await sheet.locator(".support__project-links").count(),
    0,
    `${name}: gate Support project links absent`,
  );
  await settleSupport(page);
  await page.screenshot({
    path: path.join(out, `${name}-help.png`),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
}
try {
  for (const [name, width, height, touch] of [
    ["phone", 390, 844, true],
    ["desktop", 1280, 900, false],
  ]) {
    const { page, context } = await harness.newPage(browser, {
      device: {
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
        deviceScaleFactor: 1,
      },
    });
    await page.goto(`${origin}/OpenSesame/`);
    await page.getByRole("button", { name: "Set up your own" }).waitFor();
    await gateSnapshot(page, `${name}-front-door`);
    await sealWithPin(page);
    await addCapabilities(page, ["Guided help"]);
    await openSupport(page);
    const about = page.getByText("About this project", { exact: true });
    assert.equal(
      await about.count(),
      phase === "after" ? 1 : 0,
      `${name}: unlocked Support project control`,
    );
    let geometry = [];
    if (phase === "after") {
      assert.equal(
        await about.evaluate((node) => node.closest("details").open),
        false,
      );
      await about.click();
      const links = page.locator(".support__project-links a");
      await links.first().waitFor({ state: "visible" });
      geometry = await links.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            name: node.textContent,
            href: node.href,
            target: node.target,
            rel: node.rel,
            width: box.width,
            height: box.height,
          };
        }),
      );
      assert.equal(geometry.length, 10);
      for (const link of geometry) {
        assert.ok(link.width >= 44 && link.height >= 44);
        assert.equal(link.target, "_blank");
        assert.equal(link.rel, "noopener noreferrer");
        assert.ok(
          link.href.startsWith(
            "https://github.com/Tyler-R-Kendrick/OpenSesame",
          ),
        );
      }
      assert.equal(
        geometry.find((link) => link.name === "Open a private advisory")?.href,
        "https://github.com/Tyler-R-Kendrick/OpenSesame/security/advisories/new",
      );
    }
    await settleSupport(page);
    await page.screenshot({
      path: path.join(out, `${name}-unlocked-support.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await lockVault(page);
    await page.getByLabel("PIN", { exact: true }).waitFor();
    await gateSnapshot(page, `${name}-pin-lock`);
    const environment = await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.equal(environment.coarse, touch);
    assert.equal(environment.overflow, false);
    results.push({ name, width, height, ...environment, geometry });
    await context.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(out, "geometry.json"),
    JSON.stringify(
      {
        phase,
        source,
        results,
        failures: harness.failures,
        events: harness.log,
      },
      null,
      2,
    ),
  );
}
assert.equal(results.length, 2);
assert.equal(harness.failures.length, 0, "normal static-origin harness checks");
console.log(
  `${phase}: front door, gate help, PIN lock, unlocked Support and real link geometry verified`,
);
