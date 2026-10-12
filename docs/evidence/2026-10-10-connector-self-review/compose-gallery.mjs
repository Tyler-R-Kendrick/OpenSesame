/** Compose untouched screenshots from the two actual builds with measured captions. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { composeSheet } from "../../../apps/pages/scripts/lib/visual-evidence.mjs";

const out = path.dirname(fileURLToPath(import.meta.url));
const [nativeRaw, providerBefore, providerAfter] = process.argv.slice(2);
if (!nativeRaw || !providerBefore || !providerAfter)
  throw new Error(
    "Usage: compose-gallery.mjs native-raw provider-before provider-after",
  );
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "connector-review-sheets-"),
);
const dirs = {
  before: path.join(scratch, "before"),
  after: path.join(scratch, "after"),
};
for (const directory of Object.values(dirs)) fs.mkdirSync(directory);
const sheets = [];
for (const device of ["desktop", "phone"]) {
  const width = device === "desktop" ? 1366 : 390;
  for (const id of ["github", "s3"]) {
    const shot = `${device}-${id}`;
    for (const side of ["before", "after"])
      fs.copyFileSync(
        path.join(nativeRaw, `${side}-${shot}.png`),
        path.join(dirs[side], `${shot}.png`),
      );
    sheets.push({
      shot,
      width,
      title: `${id === "github" ? "GitHub" : "S3"} native form — ${device}`,
      caption:
        id === "github"
          ? "The header and Docs link identify the actual personal-token method. Neither capture authenticates a live GitHub account."
          : "Normal driver-enabled form preserved. Driver-unavailable fallback and saved action guards are exercised by rendered integration tests.",
      before:
        id === "github"
          ? "OAuth label; OAuth App guide; overflow 0"
          : "Legacy save buttons 0; overflow 0",
      after:
        id === "github"
          ? "Personal access token; token guide; overflow 0"
          : "Legacy save buttons 0; overflow 0",
    });
  }
  for (const [kind, caption, before, after] of [
    [
      "cleanup-denied",
      "A real Vault service denies revoke-self and lookup-self. Independent root lookup proves its issued token is still valid. The fixed build retains sealed recovery.",
      "Recovery 0; remove 0; token valid",
      "Recovery 1; remove 1; token valid",
    ],
    [
      "real-oidc-installed-menu",
      "Both builds actually authorize against a locally running Vault service via OIDC and show the installed connector menu. This documents preserved working authorization, not a new cloud-provider claim.",
      "Real provider grant; installed menu",
      "Real provider grant; installed menu",
    ],
  ]) {
    const shot = `${device}-vault-${kind}`;
    fs.copyFileSync(
      path.join(providerBefore, `${shot}.png`),
      path.join(dirs.before, `${shot}.png`),
    );
    fs.copyFileSync(
      path.join(providerAfter, `${shot}.png`),
      path.join(dirs.after, `${shot}.png`),
    );
    sheets.push({
      shot,
      width,
      title: `Vault ${kind === "cleanup-denied" ? "cleanup denial" : "verified installed connector"} — ${device}`,
      caption,
      before,
      after,
    });
  }
}
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const sheet of sheets) await composeSheet(browser, sheet, dirs, out);
} finally {
  await browser.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
