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
  process.env.PWA_TAILSCALE_EVIDENCE_OUT ??
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
    const old = before.measurements
      .find((m) => m.width === width && m.step === "real-peer")
      .statuses.find((s) => s.inHeader);
    const next = after.measurements
      .find((m) => m.width === width && m.step === "real-peer")
      .statuses.find((s) => s.inHeader);
    const rows = [
      {
        step: "real-peer",
        title: "Real SDK membership and native-tailnet HTTP200",
        before: `Header: ${old.label}; actual child Connected and real peer GET succeeded`,
        after: `Header: ${next.label}; proof was already current before peer GET`,
      },
      {
        step: "home-connected",
        title: "Ordinary Connections home and navigation, without Reload",
        before:
          width === 1280
            ? "Nothing connected; expanded Connected rail count empty, current node absent"
            : "Nothing connected while actual node remains running",
        after:
          width === 1280
            ? "Current node connected; expanded rail count1 and hostname leaf"
            : "Current node connected in ordinary home list",
      },
      {
        step: "networking-withdrawn",
        title: "After actual Networking consent withdrawal",
        before:
          "Header Needs you; actual SDK worker terminated; no live authorization",
        after:
          "Header Browser node not connected; actual SDK worker terminated",
      },
    ];
    const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><h1>Tailscale browser-node live status — ${width}px</h1><p>Actual matched loopback production builds, official WASM SDK and real Headscale/DERP/native peer. Normal PIN-vault/configuration UI. Provider fixture uses narrow SPKI-only DERP certificate trust; no hosted account or ordinary hosted PKI claim.</p>${rows.map((r) => `<h2>${r.title}</h2><div class="pair">${figure("before", width, r.step, r.before)}${figure("after", width, r.step, r.after)}</div>`).join("")}`;
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
    const file = `${width}-tailscale-status.png`;
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
