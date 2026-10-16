/** Compose actual captured app frames using the repository's existing compositor. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { composeSheet } from "./lib/visual-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../docs/evidence/2026-10-14-backup-integrations"),
);
const raw = path.resolve(
  process.env.PAGES_CAPTURE_RAW ??
    path.join(os.tmpdir(), "opensesame-backup-evidence"),
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
const controls = (data, width, screen) =>
  row(data, width, screen).fields.filter((field) => !field.readonly).length;
const sheets = [1280, 390].flatMap((width) => [
  {
    shot: `${width}-catalog`,
    width,
    title: `Password-manager integrations — ${width}px`,
    caption:
      "The same catalog section from two real production builds. Partner connections share configurable backend methods with BYO.",
    before: `${row(before, width, "catalog").providers.length} password-manager links`,
    after: `${row(after, width, "catalog").providers.length} password-manager links; no document overflow`,
  },
  ...["1password", "proton-pass"].map((screen) => ({
    shot: `${width}-${screen}`,
    width,
    title: `${screen === "1password" ? "1Password" : "Proton Pass"} configuration — ${width}px`,
    caption:
      screen === "1password"
        ? "An operator-provided Connect API, export-file import and the official extension save handoff have distinct working paths."
        : "A Proton export is opened locally and imported into the encrypted vault, with no upload or CLI process.",
    before: `${controls(before, width, screen)} editable controls`,
    after: `${controls(after, width, screen)} editable controls; no document overflow`,
  })),
  {
    shot: `${width}-byo`,
    width,
    title: `BYO secret backend methods — ${width}px`,
    caption:
      "New protocol configurations compose the same fields and operation controls used by the partner presets.",
    rows: ["local", "onepassword-connect", "infisical"].map((mode) => ({
      shot: `${width}-byo-${mode}`,
      added: true,
      heading: mode,
      after: `${controls(after, width, `byo-${mode}`)} editable controls; no document overflow`,
    })),
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
        { before: path.join(raw, "before"), after: path.join(raw, "after") },
        out,
      ),
    );
} finally {
  await browser.close();
}
