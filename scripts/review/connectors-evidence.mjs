import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [phase, root, dist, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const imp = (p) => import(pathToFileURL(path.join(root, p)));
const { createHarness } = await imp(
  "apps/pages/scripts/lib/static-origin-harness.mjs",
);
const { sealWithPin, addCapabilities } = await imp(
  "apps/pages/scripts/lib/pages-journey.mjs",
);
const { tabStep } = await imp("apps/pages/scripts/lib/capture-tab-step.mjs");
const origin = "https://tyler-r-kendrick.github.io";
const harness = createHarness({ dist, origin, base: "/OpenSesame/", out });
const browser = await harness.launch({ args: ["--no-sandbox"] });
const results = [];
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
    await sealWithPin(page);
    await addCapabilities(page, ["External connectors"]);
    const visit = async (page, route) => {
      await page.evaluate((href) => {
        history.pushState(null, "", href);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/OpenSesame/${route}`);
    };
    await tabStep({ press: (el) => el.click(), visit }).tab(
      page,
      "Connections",
    );
    await page.locator(".conn-tile").first().waitFor({ timeout: 15000 });
    const tiles = await page.locator(".conn-tile").evaluateAll((nodes) =>
      nodes.map((node) => {
        const target = node.querySelector(".conn-tile__link");
        const b = target.getBoundingClientRect();
        return {
          id: decodeURIComponent(node.id.replace(/^catalog-/, "")),
          name: node.querySelector(".conn-tile__name")?.textContent,
          tag: target.tagName,
          href: target.getAttribute("href"),
          label: target.getAttribute("aria-label"),
          title: target.getAttribute("title"),
          width: b.width,
          height: b.height,
          glyph: target.querySelector(".conn-tile__go")?.outerHTML,
        };
      }),
    );
    const environment = await page.evaluate(() => ({
      coarse: matchMedia("(pointer:coarse)").matches,
      overflow: document.documentElement.scrollWidth > innerWidth,
      body: document.body.innerText.slice(0, 1000),
    }));
    await page.locator("#catalog").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, `${name}-catalog.png`),
      fullPage: true,
    });
    for (const id of ["obsidian", "polar"]) {
      const tile = page.locator(`#catalog-${id}`);
      if (await tile.count()) {
        await tile.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(out, `${name}-${id}.png`),
          fullPage: true,
        });
      }
    }
    const azure = page.locator("#catalog-azure-sm a");
    let family = null;
    if (await page.locator("#catalog-azure-sm").count()) {
      if (await azure.count()) await azure.click();
      else await visit(page, "connections/azure-sm");
      const select = page.getByLabel("API family", { exact: true });
      await select.waitFor({ timeout: 15000 });
      family = await select.evaluate((el) => ({
        value: el.value,
        options: [...el.options].map((o) => ({
          value: o.value,
          label: o.textContent,
          selected: o.selected,
        })),
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      }));
      await page.screenshot({
        path: path.join(out, `${name}-azure.png`),
        fullPage: true,
      });
    }
    results.push({ name, width, height, touch, ...environment, tiles, family });
    await context.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(out, "geometry.json"),
    JSON.stringify(
      {
        phase,
        root,
        dist,
        results,
        log: harness.log,
        failures: harness.failures,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify(
    results.map((r) => ({
      name: r.name,
      tiles: r.tiles.length,
      connect: r.tiles.filter((t) => t.tag === "A").length,
      blocked: r.tiles.filter((t) => t.tag !== "A").length,
      family: r.family,
    })),
    null,
    2,
  ),
);

assert.equal(results.length, 2);
for (const r of results) {
  assert.equal(r.coarse, r.touch);
  assert.equal(r.overflow, false);
  assert.ok(r.tiles.length > 20);
  if (r.touch)
    for (const t of r.tiles)
      assert.ok(
        t.height >= 44 && t.width >= 44,
        `${t.id} target ${t.width}x${t.height}`,
      );
  if (phase === "after") {
    for (const id of [
      "aws",
      "gcp",
      "snowflake",
      "github",
      "make",
      "zapier",
      "attio",
      "asana",
      "polar",
      "fal-ai",
      "higgsfield",
      "obsidian",
      "azure-sm",
    ]) {
      const t = r.tiles.find((t) => t.id === id);
      assert.ok(t, `${id} catalog tile exists`);
      assert.equal(t.tag, "A", `${id} browser configuration road`);
      assert.ok(t.label?.startsWith("Connect "), `${id} Connect road`);
    }
    assert.ok(r.family, "Azure family visible");
    assert.equal(r.family.value, "azure-sm");
    assert.ok(
      r.family.options.every((o) => o.label !== o.value),
      "friendly Azure labels",
    );
  }
}
