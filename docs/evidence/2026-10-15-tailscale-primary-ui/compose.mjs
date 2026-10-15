/** Captions surround full unaltered viewport captures at their natural dimensions. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = process.cwd();
const { chromium } = createRequire(path.join(repo, "apps/pages/package.json"))(
  "@playwright/test",
);
const root =
  process.env.PWA_TAILSCALE_PRIMARY_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(
  fs.readFileSync(path.join(root, "before-metrics.json")),
);
const after = JSON.parse(
  fs.readFileSync(path.join(root, "after-metrics.json")),
);
if (before.failures.length || after.failures.length)
  throw Error("Both actual-build journeys must pass");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM,
  headless: true,
  args: ["--no-sandbox"],
});
const layout = [];
function figure(phase, width, step, note) {
  const file = `raw/${phase}/${width}-${step}.png`;
  const data = fs.readFileSync(path.join(root, file)).toString("base64");
  return `<figure style="width:${width}px;flex:none"><figcaption>${phase}<span>${note}</span></figcaption><img data-source="${file}" src="data:image/png;base64,${data}" width="${width}" height="900" alt="Actual ${phase} ${step} viewport"></figure>`;
}
const css =
  "*{box-sizing:border-box}body{margin:0;padding:28px;background:#fafafa;color:#171717;font-family:ui-monospace,monospace;width:max-content}h1{font-size:17px;line-height:24px;margin:0 0 8px}p{font:13px/20px system-ui;max-width:90ch;margin:0 0 20px;color:#555}h2{font-size:13px;line-height:20px;margin:24px 0 10px}.pair{display:flex;gap:22px;align-items:flex-start}figure{margin:0}figcaption{font-size:12px;line-height:18px;font-weight:600;text-transform:uppercase;height:82px}figcaption span{display:block;font-size:11px;font-weight:400;text-transform:none;max-width:100%}img{display:block;border:0;padding:0;margin:0;max-width:none;max-height:none}";
try {
  for (const width of [1280, 390]) {
    const rows = [
      {
        step: "configured-primary",
        title: "Initial peering configuration",
        before:
          "Four primary panels; unrelated registration form follows browser peering",
        after: "One primary panel; normal browser-peering controls remain",
      },
      {
        step: "cold-restored-primary",
        title:
          "Cold document reload, real PIN unlock and saved node restoration",
        before: "Saved node fields restore; unrelated app forms remain mounted",
        after:
          "Same saved node fields restore; Connect is ready with no extra app forms",
      },
    ];
    const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><h1>Tailscale primary peering configuration — ${width}px</h1><p>Actual matched production-profile builds and normal PIN-vault configuration UI. Both complete real official-SDK peering and native-peer GETs; these screenshots show stopped, configured states. Fixture uses narrow SPKI-only DERP certificate trust; no hosted-account claim.</p>${rows.map((r) => `<h2>${r.title}</h2><div class="pair">${figure("before", width, r.step, r.before)}${figure("after", width, r.step, r.after)}</div>`).join("")}`;
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    const images = await page.locator("img").evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          source: n.dataset.source,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          naturalWidth: n.naturalWidth,
          naturalHeight: n.naturalHeight,
        };
      }),
    );
    if (
      images.some(
        (r) =>
          r.width !== width ||
          r.height !== 900 ||
          r.naturalWidth !== width ||
          r.naturalHeight !== 900,
      )
    )
      throw Error("Viewport screenshot dimensions changed");
    const file = `${width}-tailscale-primary-ui.png`;
    await page.locator("body").screenshot({ path: path.join(root, file) });
    layout.push({ file, images });
    await page.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(
  path.join(root, "composition-layout.json"),
  `${JSON.stringify(layout, null, 2)}\n`,
);
