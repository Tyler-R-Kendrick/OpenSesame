/** Compose only captured build frames; badges use measured DOM counts. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { privateSharedTempDir } from "./lib/private-files.mjs";
import { composeSheet } from "./lib/visual-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(
      here,
      "../../../work/evidence/integration-settings/pages/browser",
    ),
);
const raw = path.resolve(
  process.env.PAGES_CAPTURE_RAW ??
    privateSharedTempDir("opensesame-integration-followup-evidence"),
);
const before = JSON.parse(
  fs.readFileSync(path.join(out, "before-metrics.json"), "utf8"),
);
const after = JSON.parse(
  fs.readFileSync(path.join(out, "after-metrics.json"), "utf8"),
);
const row = (data, width, screen) =>
  data.metrics.find(
    (entry) => entry.width === width && entry.screen === screen,
  );
const selectors = (data, width, screen) =>
  row(data, width, screen).selects.length;
const fields = (data, width, screen) =>
  row(data, width, screen).fields.filter((field) => !field.readonly).length;
const sheets = [1280, 390].flatMap((width) => [
  {
    shot: `${width}-local-storage`,
    width,
    title: `Integration catalog — ${width}px`,
    caption:
      "The same Payments-adjacent catalog viewport on two real builds. Local storage moves out of the integration catalog.",
    before: `${row(before, width, "local-storage").localStorageLinks.length} Local storage links`,
    after: `${row(after, width, "local-storage").localStorageLinks.length} Local storage links; no document overflow`,
  },
  ...["integrations-ai", "features-ai"].map((screen) => ({
    shot: `${width}-${screen}`,
    width,
    title: `${screen === "features-ai" ? "Features" : "Integrations"} AI settings — ${width}px`,
    caption:
      "Voice and Inference model choices use the standard AI feature settings, alongside approved saved AI connections.",
    before: `${selectors(before, width, screen)} model selects`,
    after: `${selectors(after, width, screen)} model selects; no document overflow`,
  })),
  {
    shot: `${width}-tailscale`,
    width,
    title: `Tailscale browser connection — ${width}px`,
    caption:
      "The browser node and optional app registration have separate explicit configuration. Actual SDK/control/DERP proof is recorded in the verification results.",
    before: `${fields(before, width, "tailscale")} editable controls`,
    after: `${fields(after, width, "tailscale")} editable controls; no document overflow`,
  },
  {
    shot: `${width}-byo-ai`,
    width,
    title: `BYO AI connection — ${width}px`,
    caption:
      "Native and BYO model providers compose the same protocol, endpoint, authentication and inference controls.",
    rows: [
      {
        shot: `${width}-byo-ai`,
        added: true,
        heading: "New shared AI configuration",
        after: `${fields(after, width, "byo-ai")} editable controls; no document overflow`,
      },
    ],
  },
]);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const sheet of sheets)
    console.log(
      await composeSheet(
        browser,
        sheet,
        {
          before: path.join(raw, "before"),
          after: path.join(raw, "after"),
        },
        out,
      ),
    );
} finally {
  await browser.close();
}
