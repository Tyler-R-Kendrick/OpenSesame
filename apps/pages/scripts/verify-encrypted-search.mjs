// Prove the Encrypted search capability in the built app, under the real
// production origin, at desktop and phone widths (ADR 0175).
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   pnpm --filter @opensesame/pages verify:encrypted-search
//
// Same harness as `verify:static`: every request to the origin is served from
// `dist/`, every other origin is refused, and the run fails on any page error,
// console error, failed request or loopback request. Per width, a guest:
//
//   A. With the capability off, retiring a password writes the device-sealed
//      database: `opensesame-password-history` exists, and the item's id is
//      readable in it. This is the control the rest is measured against.
//   B. Switching Settings › Capabilities › Encrypted search on moves that
//      database across and deletes it: only `opensesame-at-rest` and
//      `opensesame-edb-<32 hex>` remain.
//   C. Retiring another password lands in the encrypted database, and a sweep
//      of every record of every database finds no item id, no store, index or
//      field name, and none of the retired passwords' digests.
//   D. The index still answers: setting the secret back to the first password
//      is refused as used before, though that digest was moved across and now
//      lives only behind a blind index entry.
//   E. Every record of the encrypted database is `{ c: "osr2.…", x: […] }`: one
//      object store `r`, one index `x`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "./lib/always-on.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { trayText } from "./lib/tray-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "encrypted-search"),
);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { log, failures, check, setStep, launch, newPage, snap } = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});

const WIDTHS = [
  { name: "desktop", size: { width: 1280, height: 900 }, device: {} },
  {
    name: "phone",
    size: { width: 390, height: 844 },
    device: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    },
  },
];

const TITLE = "Encrypted search";
const EDB = /^opensesame-edb-[0-9a-f]{32}$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function go(page, route) {
  await page.evaluate(
    ([base, to]) => {
      history.pushState({}, "", base + to.replace(/^\//, ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [BASE, route],
  );
  await page.waitForTimeout(900);
}

/** Every database, store, index and record the origin holds, as it rests. */
async function disk(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const stores = [...db.objectStoreNames];
      const entry = { name, stores: [], indexes: [], records: [] };
      if (stores.length > 0) {
        const tx = db.transaction(stores, "readonly");
        for (const storeName of stores) {
          const store = tx.objectStore(storeName);
          entry.stores.push(storeName);
          entry.indexes.push(...store.indexNames);
          const rows = await new Promise((resolve) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
          });
          const keys = await new Promise((resolve) => {
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result);
          });
          // A CryptoKey or buffer has no text; the key store is not swept.
          if (name !== "opensesame-at-rest") {
            entry.records.push(JSON.stringify({ keys, rows }));
          }
        }
      }
      out.push(entry);
      db.close();
    }
    return out;
  });
}

async function names(page) {
  return (await disk(page)).map((entry) => entry.name);
}

async function waitFor(what, test, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Save a new secret and answer the id the app gave it. */
async function newSecret(page, name, secret) {
  await go(page, "/vault/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForTimeout(1200);
  const match = new URL(page.url()).pathname.match(/\/vault\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Change a secret's value through the editor; the page text afterwards. */
async function changeSecret(page, id, secret) {
  await go(page, `/vault/${encodeURIComponent(id)}/edit`);
  await page.getByLabel("Secret value", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForTimeout(1200);
  // A refusal is a notice in the tray, not text in the page: read both.
  const shown = await page.evaluate(() => document.body.innerText);
  return `${shown}\n${await trayText(page)}`;
}

const browser = await launch();
for (const width of WIDTHS) {
  const label = width.name;
  const { page, context } = await newPage(browser, { device: width.device });
  await page.setViewportSize(width.size);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  setStep(`${label}-guest`);
  await doorGuest(page).click();
  await waitOpen(page);

  const first = `pw-one-${label}-7f3a`;
  const second = `pw-two-${label}-7f3a`;
  const third = `pw-three-${label}-7f3a`;

  // A
  setStep(`${label}-off`);
  const id = await newSecret(page, `Bank ${label}`, first);
  check(id !== null, `${label}: a new secret was saved and has an id`);
  await changeSecret(page, id, second);
  const waitingOff = await waitFor("legacy", async () =>
    (await names(page)).includes("opensesame-password-history"),
  );
  check(
    waitingOff,
    `${label}: off, a retired password writes the sealed database`,
  );
  const before = await disk(page);
  const legacy = before.find((d) => d.name === "opensesame-password-history");
  check(
    legacy?.records.join("").includes(id) === true,
    `${label}: off, the item's id is readable in that database (the control)`,
  );
  check(
    !before.some((d) => EDB.test(d.name)),
    `${label}: off, no encrypted database exists`,
  );
  await snap(page, `${label}-before`);

  // B
  setStep(`${label}-on`);
  await go(page, "/settings/capabilities");
  await awaitCapabilitySections(page);
  const add = capabilityOffSwitch(page, TITLE);
  await add.waitFor({ timeout: 15000 });
  await add.click();
  await capabilityOnSwitch(page, TITLE).waitFor({ timeout: 15000 });
  await snap(page, `${label}-capability-on`);
  const moved = await waitFor("moved", async () => {
    const found = await names(page);
    return (
      !found.includes("opensesame-password-history") &&
      found.some((name) => EDB.test(name))
    );
  });
  check(moved, `${label}: on, the sealed database is moved across and deleted`);
  const after = await names(page);
  check(
    after.every((name) => name === "opensesame-at-rest" || EDB.test(name)),
    `${label}: on, only the key store and encrypted databases remain (${after.join(", ")})`,
  );

  // C
  setStep(`${label}-retire`);
  await changeSecret(page, id, third);
  await page.waitForTimeout(800);
  const rest = await disk(page);
  const encrypted = rest.filter((d) => EDB.test(d.name));
  check(
    encrypted.length >= 1,
    `${label}: on, an encrypted database holds the digests`,
  );
  const sweep = rest.map((d) => d.name + d.records.join("")).join("\n");
  for (const secret of [
    id,
    `Bank ${label}`,
    "digests",
    "by_scope",
    "scope",
    sha256(first),
    sha256(second),
    sha256(third),
  ]) {
    check(
      !sweep.includes(secret),
      `${label}: nothing readable holds ${secret.slice(0, 14)}…`,
    );
  }
  check(
    encrypted.every(
      (d) =>
        d.stores.length === 1 &&
        d.stores[0] === "r" &&
        d.indexes.length === 1 &&
        d.indexes[0] === "x",
    ),
    `${label}: each encrypted database is one store and one index`,
  );
  check(
    encrypted.every((d) =>
      JSON.parse(d.records.join("")).rows.every(
        (row) => /^osr2\./.test(row.c) && Array.isArray(row.x),
      ),
    ),
    `${label}: every record is a sealed row and its index entries`,
  );

  // D
  setStep(`${label}-lookup`);
  const refused = await changeSecret(page, id, first);
  check(
    /used before/i.test(refused),
    `${label}: a retired password moved across is still found, and refused`,
  );
  await snap(page, `${label}-refused`);

  await context.close();
}
await browser.close();

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);

const hard = log.filter((entry) =>
  [
    "LOOPBACK-REQUEST",
    "HTTP-ERROR",
    "PAGE-ERROR",
    "console-error",
    "ON-SCREEN",
    "MISSING-ASSET",
  ].includes(entry.kind),
);
for (const entry of hard) {
  console.log(`${entry.kind} [${entry.step}] ${entry.detail.slice(0, 240)}`);
}
if (failures.length || hard.length) {
  console.log(
    `\n${failures.length} failed checks, ${hard.length} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
