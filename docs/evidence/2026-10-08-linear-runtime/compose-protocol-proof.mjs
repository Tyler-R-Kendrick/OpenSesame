/** Label real after-build screenshots; the app's state came only from its UI and HTTP protocol. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "../../../apps/pages/scripts/lib/static-origin-harness.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const captures = process.env.PAGES_VERIFY_OUT;
if (!captures)
  throw new Error(
    "Set PAGES_VERIFY_OUT to a passing browser contract's capture directory",
  );
const harness = createHarness({ dist: "", origin: "", base: "", out: root });
const browser = await harness.launch();
try {
  for (const [label, width] of [
    ["desktop", 1280],
    ["phone", 390],
  ]) {
    for (const [kind, shots] of [
      [
        "protocol",
        [
          [
            "Verified account and workspace",
            `${label}_connected_protocol_test.png`,
          ],
          [
            "Provider issue mutation result",
            `${label}_verified_protocol_test.png`,
          ],
        ],
      ],
      [
        "recovery",
        [
          [
            "Cleanup refused — previous webhook retained, explicit retry",
            `${label}_cleanup_retry_protocol_test.png`,
          ],
          [
            "Temporary admin revoked — final read-only authorization",
            `${label}_narrowed_recovery_protocol_test.png`,
          ],
        ],
      ],
    ]) {
      const frames = shots.map(([caption, file]) => {
        const source = fs
          .readFileSync(path.join(captures, file))
          .toString("base64");
        return `<figure><figcaption>${caption}</figcaption><img width="${width}" src="data:image/png;base64,${source}"></figure>`;
      });
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      await page.setContent(
        `<!doctype html><style>body{margin:0;padding:24px;background:#fafafa;color:#171717;font:14px ui-monospace,monospace;width:max-content}h1{font-size:18px;margin:0 0 8px}p{max-width:85ch;font:14px system-ui;line-height:1.5;margin:0 0 20px}main{display:flex;gap:20px}figure{margin:0}figcaption{margin-bottom:10px;max-width:${width}px;line-height:1.4}img{display:block;border:1px solid #d4d4d4}</style><h1>Linear browser ${kind} contract — ${label}</h1><p>After-build app screens driven through real controls. Linear HTTPS requests were answered by an explicit protocol test authority with a test account and workspace. These are integration-test results; no live-account authorization is claimed.</p><main>${frames.join("")}</main>`,
      );
      await page
        .locator("body")
        .screenshot({ path: path.join(root, `${label}-${kind}-proof.png`) });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
