#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Playwright capture for org vault addressing (ADR 0181).
 */
import { chromium } from "@playwright/test";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(root, "../../../apps/pages/dist");
const base = `file://${dist}/index.html`;

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(`${base}#/guest`, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("link", { name: /skip/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  const shots = [
    ["org-directory.png", "#/settings/sharing/relay"],
    ["vault-list-address.png", "#/vault"],
    ["create-org-vault.png", "#/settings/sharing/relay"],
    ["member-publish-refused.png", "#/settings/sharing/relay"],
  ];

  for (const [name, hash] of shots) {
    await page.goto(`${base}${hash}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(root, name), fullPage: true });
    console.log("wrote", name);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
