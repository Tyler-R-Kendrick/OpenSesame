import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [phase, sourcePath, outputPath] = process.argv.slice(2);
assert.ok(["before", "after"].includes(phase), "phase must be before or after");
assert.ok(
	sourcePath && outputPath,
	"source checkout and output directory required",
);
const source = path.resolve(sourcePath);
const out = path.resolve(outputPath);
const moduleAt = (relative) =>
	import(pathToFileURL(path.join(source, relative)));
const { createHarness } = await moduleAt(
	"apps/pages/scripts/lib/static-origin-harness.mjs",
);
const { phoneContext } = await moduleAt(
	"apps/pages/scripts/lib/mobile-contract.mjs",
);
const { sealWithPin } = await moduleAt(
	"apps/pages/scripts/lib/pages-journey.mjs",
);
// This file is checked out from the transient workflow branch based on the
// reviewed candidate. Its helper is the exact candidate check, also run on the
// before build to prove that the check detects the original regression.
const { lockedReload } = await import(
	"../../apps/pages/scripts/lib/mobile-gates.mjs"
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
let regression;
try {
	for (const [name, width, height, touch] of [
		["320", 320, 568, true],
		["390", 390, 844, true],
		["430", 430, 932, true],
		["landscape", 844, 390, true],
		["wide-touch", 1366, 1024, true],
		["narrow-mouse", 900, 900, false],
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
		await page.getByRole("button", { name: "About this project" }).click();
		const links = page.locator(".unlock__notes-about-list a");
		await links.first().waitFor({ state: "visible" });
		const geometry = await links.evaluateAll((nodes) =>
			nodes.map((link) => {
				const box = link.getBoundingClientRect();
				return {
					label: link.textContent,
					width: box.width,
					height: box.height,
					display: getComputedStyle(link).display,
				};
			}),
		);
		const environment = await page.evaluate(() => ({
			coarse: matchMedia("(pointer: coarse)").matches,
			overflow: document.documentElement.scrollWidth > innerWidth,
			viewport: innerWidth,
		}));
		await page.locator(".unlock__notes-about-list").scrollIntoViewIfNeeded();
		await page.screenshot({
			path: path.join(out, `${name}.png`),
			fullPage: true,
		});
		results.push({ name, width, height, touch, ...environment, geometry });
		await context.close();
	}
	const { page, context } = await harness.newPage(browser, {
		device: phoneContext({ width: 390, height: 844 }),
	});
	await page.goto(`${origin}/OpenSesame/`);
	await sealWithPin(page);
	await lockedReload(page, (name) => name, {
		harness,
		openTab: async () => {},
		audit: async () => {},
	});
	regression = {
		phase,
		failures: [...harness.failures],
		checks: harness.log.filter((item) => ["PASS", "FAIL"].includes(item.kind)),
	};
	await context.close();
} finally {
	await browser.close();
	fs.writeFileSync(
		path.join(out, "geometry.json"),
		JSON.stringify({ phase, source, results, log: harness.log }, null, 2),
	);
	fs.writeFileSync(
		path.join(out, "regression.json"),
		JSON.stringify(regression ?? { phase, incomplete: true }, null, 2),
	);
}
assert.equal(results.length, 7);
for (const result of results) {
	assert.equal(
		result.geometry.length,
		10,
		`${result.name}: ten documentation links`,
	);
	assert.equal(result.coarse, result.touch, `${result.name}: correct pointer`);
	assert.equal(
		result.overflow,
		false,
		`${result.name}: no horizontal overflow`,
	);
	const enlarged = phase === "after" && (result.touch || result.width <= 900);
	for (const box of result.geometry) {
		assert.ok(box.width >= 44, `${result.name}: ${box.label} width`);
		assert.equal(
			box.height,
			enlarged ? 44 : 21,
			`${result.name}: ${box.label} height`,
		);
	}
}
assert.equal(regression.failures.length, phase === "before" ? 10 : 0);
assert.equal(regression.checks.length, 10);
assert.equal(
	harness.log.filter((item) => item.kind === "PAGE-ERROR").length,
	0,
);
console.log(
	`${phase}: seven contexts and ten locked-vault regression checks verified`,
);
