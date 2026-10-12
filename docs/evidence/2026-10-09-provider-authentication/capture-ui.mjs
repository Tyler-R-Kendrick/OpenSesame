/** Real immutable builds on one HTTPS origin; no provider auth responses are fabricated. */
import assert from "node:assert/strict";
import { X509Certificate, createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phoneContext } from "../../../apps/pages/scripts/lib/mobile-contract.mjs";
import {
  nativeEnableConnections,
  nativeVisit,
} from "../../../apps/pages/scripts/lib/native-browser-catalog-journey.mjs";
import { sealWithPin } from "../../../apps/pages/scripts/lib/pages-journey.mjs";
import { composeSheet } from "../../../apps/pages/scripts/lib/visual-evidence.mjs";
import { startProviderAuthOrigin } from "../../../apps/pages/scripts/provider-auth-origin.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(path.join(root, "apps/pages/package.json"));
const { chromium } = require("@playwright/test");
const before = path.resolve(process.env.PROVIDER_UI_BEFORE_DIST);
const after = path.resolve(process.env.PROVIDER_UI_AFTER_DIST);
const tls = path.resolve(process.env.PROVIDER_UI_TLS);
const scratch = path.resolve(process.env.PROVIDER_UI_CAPTURES);
const out = path.dirname(fileURLToPath(import.meta.url));
const base = "/OpenSesame/";
const profile = JSON.parse(
  fs.readFileSync(path.join(after, "security-profile.json"), "utf8"),
);
assert.equal(profile.profile, "dedicated_origin");
assert.equal(profile.headerSecurity, true);
const origin = new URL(profile.canonicalOrigin);
assert.equal(origin.protocol, "https:");
const certificate = new X509Certificate(
  fs.readFileSync(path.join(tls, "vault-cert.pem")),
);
const spki = createHash("sha256")
  .update(certificate.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");

function manifest(directory) {
  const entries = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else
        entries.push({
          path: path.relative(directory, file),
          sha256: createHash("sha256")
            .update(fs.readFileSync(file))
            .digest("hex"),
        });
    }
  }
  walk(directory);
  return entries;
}

async function measurements(page) {
  return page.locator("main").evaluate((main) => {
    const visible = (element) =>
      element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      }) &&
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0;
    const inputs = [...main.querySelectorAll("input")].filter(visible);
    const tiles = [...main.querySelectorAll(".conn-tile")];
    return {
      visibleInputs: inputs.length,
      visibleFileInputs: inputs.filter((input) => input.type === "file").length,
      tiles: tiles.length,
      linkedTiles: tiles.filter((tile) => tile.querySelector("a")).length,
      computerGlyphs: tiles.filter((tile) =>
        [...tile.querySelectorAll("svg title")].some(
          (title) => title.textContent === "Desktop app required",
        ),
      ).length,
      smallestControl: Math.min(
        ...[
          ...main.querySelectorAll(
            "button, input:not([type=radio]):not([type=checkbox]), select, .conn-tile__link, .cx-choices label",
          ),
        ]
          .filter(visible)
          .map((element) => element.getBoundingClientRect().height),
      ),
    };
  });
}

async function capture(browser, directory, label) {
  const server = await startProviderAuthOrigin({
    dist: directory,
    tls,
    base,
    hostname: origin.hostname,
    port: Number(origin.port),
  });
  const rows = [];
  try {
    for (const [deviceLabel, device] of [
      ["desktop", { viewport: { width: 1366, height: 1000 } }],
      ["phone", phoneContext({ width: 390, height: 844 })],
    ]) {
      const context = await browser.newContext({
        ...device,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${server.origin}${base}`);
      await sealWithPin(page);
      await nativeEnableConnections(page, base);
      await nativeVisit(page, base, "settings/general");
      await page.getByRole("button", { name: "Night", exact: true }).click();
      for (const [view, route] of [
        ["vault-signin", "connections/vault"],
        ["catalog-actions", "connections#catalog"],
      ]) {
        await nativeVisit(page, base, route);
        const heading =
          view === "vault-signin" ? "HashiCorp Vault" : "Add a connection";
        await page
          .getByRole("heading", { name: heading, exact: true })
          .waitFor();
        await page.waitForTimeout(600);
        const shot = `${deviceLabel}-${view}`;
        rows.push({ shot, label, ...(await measurements(page)) });
        await page.screenshot({
          path: path.join(scratch, label, `${shot}.png`),
        });
      }
      assert.deepEqual(
        errors,
        [],
        `${label}/${deviceLabel}: no browser errors`,
      );
      await context.close();
    }
  } finally {
    await server.close();
  }
  return rows;
}

for (const label of ["before", "after"])
  fs.mkdirSync(path.join(scratch, label), { recursive: true });
const originals = { before: manifest(before), after: manifest(after) };
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM,
  headless: true,
  env: {
    ...process.env,
    NO_PROXY: [process.env.NO_PROXY, origin.hostname].filter(Boolean).join(","),
    no_proxy: [process.env.no_proxy, origin.hostname].filter(Boolean).join(","),
  },
  args: [
    `--host-resolver-rules=MAP ${origin.hostname} 127.0.0.1`,
    `--proxy-bypass-list=${origin.hostname}`,
    `--ignore-certificate-errors-spki-list=${spki}`,
  ],
});
try {
  const rows = [
    ...(await capture(browser, before, "before")),
    ...(await capture(browser, after, "after")),
  ];
  for (const device of ["desktop", "phone"]) {
    for (const view of ["vault-signin", "catalog-actions"]) {
      const shot = `${device}-${view}`;
      const previous = rows.find(
        (row) => row.shot === shot && row.label === "before",
      );
      const current = rows.find(
        (row) => row.shot === shot && row.label === "after",
      );
      const notes =
        view === "vault-signin"
          ? [
              `${previous.visibleInputs} visible inputs; ${previous.visibleFileInputs} icon upload`,
              `${current.visibleInputs} visible inputs; ${current.visibleFileInputs} icon upload`,
            ]
          : [
              `${previous.linkedTiles} linked cards; ${previous.computerGlyphs} computer glyphs`,
              `${current.linkedTiles} linked cards; ${current.computerGlyphs} computer glyphs`,
            ];
      await composeSheet(
        browser,
        {
          shot,
          width: device === "desktop" ? 1366 : 390,
          title: `${view === "vault-signin" ? "Vault sign-in" : "Connector card actions"} — ${device}`,
          caption:
            "Two real builds, same HTTPS origin, viewport and product steps. Provider sign-in and native runtime capability precede cosmetic configuration.",
          before: notes[0],
          after: notes[1],
        },
        {
          before: path.join(scratch, "before"),
          after: path.join(scratch, "after"),
        },
        out,
      );
    }
  }
  assert.deepEqual(
    manifest(before),
    originals.before,
    "Baseline artifact remains byte-exact",
  );
  assert.deepEqual(
    manifest(after),
    originals.after,
    "Final artifact remains byte-exact",
  );
  fs.writeFileSync(
    path.join(out, "ui-measurements.json"),
    `${JSON.stringify({ canonicalOrigin: origin.origin, headerSecurity: true, before: originals.before, after: originals.after, rows }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(rows)}\n`);
} finally {
  await browser.close();
}
