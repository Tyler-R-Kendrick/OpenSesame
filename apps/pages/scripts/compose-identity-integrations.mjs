/** Reuse the repository's browser compositor for measured identity evidence sheets. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { privateSharedTempDir } from "./lib/private-files.mjs";
import { composeSheet } from "./lib/visual-evidence.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../docs/evidence/2026-10-14-identity-integrations"),
);
const raw = path.resolve(
  process.env.PAGES_CAPTURE_RAW ??
    privateSharedTempDir("opensesame-identity-evidence"),
);
const dirs = {
  before: path.join(raw, "before"),
  after: path.join(raw, "after"),
};
const after = JSON.parse(
  fs.readFileSync(path.join(out, "after-metrics.json"), "utf8"),
);
const fieldCount = (width, screen) =>
  after.metrics.find((row) => row.width === width && row.screen === screen)
    .fields.length;
const sheets = [1280, 390].flatMap((width) => [
  {
    shot: `${width}-catalog`,
    width,
    title: `Identity integrations — ${width}px`,
    caption:
      "Two real builds, the same Settings Integrations page. Every identity option opens a common configurable connection.",
    before: "3 identity options",
    after: "8 identity options; no horizontal overflow",
  },
  {
    shot: `${width}-better-auth`,
    width,
    title: `Better Auth configuration — ${width}px`,
    caption:
      "The previous unsupported browser-connection explanation becomes a working native session configuration, with OIDC as an alternate protocol.",
    before: "0 configuration controls; no connection path",
    after: `${fieldCount(width, "better-auth")} controls including readonly browser origin and token verification options; no horizontal overflow`,
  },
  {
    shot: `${width}-byo`,
    width,
    title: `BYO Identity protocols — ${width}px`,
    caption:
      "New BYO screens compose the same configuration controls used by the partner presets. SAML and LDAP name the sign-in service and organization that run the server-side ceremony.",
    rows: ["oidc", "saml", "ldap"].map((protocol) => ({
      shot: `${width}-byo-${protocol}`,
      added: true,
      heading: protocol.toUpperCase(),
      after: `${fieldCount(width, `byo-${protocol}`)} controls; no horizontal overflow`,
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
    console.log(await composeSheet(browser, sheet, dirs, out));
} finally {
  await browser.close();
}
