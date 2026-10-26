/**
 * Round 8 install-profile evidence: the browser walks.
 *
 * P8-1 walks the guest drop the way `verify-portable-drop.mjs` does: share
 * form, then the Drop ready region. P8-2 starts a live session, copies the
 * peer-trust signal, and stops when the host's admit control is on screen
 * (SAS compare, or Let in on the earlier build). It does not finish WebRTC.
 */

import fs from "node:fs";
import path from "node:path";
import { doorGuest } from "./front-door.mjs";
import {
  copyFrom,
  joinerAsks,
  ownerEnters,
  startSession,
} from "./live-join-walk.mjs";
import { waitOpen } from "./pages-journey.mjs";
import { harnessFor, openPage } from "./round8-profile-browser.mjs";
import {
  BASE,
  JOINER,
  ORIGIN,
  SECRET,
  SHOT_ROOT,
  log,
} from "./round8-profile-plan.mjs";

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

async function createSecret(page, name, value) {
  await go(page, "/vault/new");
  const nameField = page.getByLabel("Name", { exact: true });
  await nameField.waitFor({ timeout: 20_000 });
  await nameField.fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name, exact: true })
    .waitFor({ timeout: 20_000 });
}

export function textCounts(text) {
  const n = (needle) => text.split(needle).length - 1;
  return {
    any: n("Any browser with the link"),
    here: n("This browser"),
    warning: n("Only this browser can open this drop"),
  };
}

async function opensOn(scope) {
  const rows = scope.locator(".frow");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const label = (
      await row
        .locator(".frow__label")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    if (label !== "Opens on") continue;
    const value = row.locator(".frow__value").first();
    if ((await value.count()) === 0) return "";
    return (await value.innerText()).replace(/\s+/g, " ").trim();
  }
  return "";
}

async function measureRegion(scope) {
  const text = await scope.innerText();
  return { ...textCounts(text), opensOn: await opensOn(scope) };
}

export async function shoot(page, locator, file) {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await page.waitForTimeout(250);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
}

export async function captureDrop(page, files) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await waitOpen(page);
  await createSecret(page, "Harbor note", "harbor-lantern-42");
  await page.getByRole("button", { name: "Share once" }).click();
  const share = page.getByRole("region", { name: "Share this item once" });
  await share.waitFor({ timeout: 15_000 });
  const shareMeasure = await measureRegion(share);
  await shoot(page, share, files.share);
  await page.getByRole("button", { name: "Seal and share" }).click();
  const ready = page.getByRole("region", { name: "Drop ready" });
  await ready.waitFor({ timeout: 30_000 });
  const readyMeasure = await measureRegion(ready);
  await shoot(page, ready, files.ready);
  return { share: shareMeasure, ready: readyMeasure };
}

export async function labeledValue(scope, label) {
  const rows = scope.locator(".frow");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = (
      await row
        .locator(".frow__label")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    if (text !== label) continue;
    const value = row.locator(".frow__value").first();
    if ((await value.count()) === 0) return "";
    return (await value.innerText()).replace(/\s+/g, " ").trim();
  }
  return null;
}

async function readSas(locator) {
  if ((await locator.count()) === 0) return "";
  return (await locator.innerText()).trim();
}

async function readExportPanel(panel, measure) {
  const copyKey = panel.getByRole("button", {
    name: "Copy peer trust signal",
  });
  const unavailable = panel.getByText(
    "Peer trust is not available on this device",
    { exact: true },
  );
  await copyKey.or(unavailable).first().waitFor({ timeout: 25_000 });
  measure.unavailable = await unavailable.count();
  measure.copy = await copyKey.count();
  measure.qr = await panel
    .getByRole("button", { name: "Show fingerprint QR" })
    .count();
  measure.fingerprint = await labeledValue(panel, "Fingerprint");
  measure.shortAuth = await labeledValue(panel, "Short authentication string");
  return copyKey;
}

async function compareJoiner({
  owner,
  harness,
  browser,
  device,
  started,
  signal,
  files,
  measure,
}) {
  const joiner = await openPage(harness, browser, device);
  try {
    const request = await joinerAsks(joiner.page, {
      link: started.link,
      code: started.code,
      name: JOINER,
      peerTrust: signal,
    });
    measure.joinerSas = await readSas(joiner.page.locator(".live-sas").first());
    const panel = started.panel;
    await panel
      .getByLabel("Paste a join request", { exact: true })
      .fill(request);
    await panel.getByRole("button", { name: "Read the request" }).click();
    const match = panel.getByRole("button", {
      name: `Yes, they match for ${JOINER}`,
    });
    const letIn = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await match.or(letIn).first().waitFor({ timeout: 20_000 });
    measure.match = await match.count();
    measure.letIn = await letIn.count();
    const guest = panel.locator(".vault-row", { hasText: JOINER }).first();
    measure.rowSas = await readSas(guest.locator(".live-sas").first());
    await shoot(owner.page, guest, files.compare);
  } finally {
    await joiner.context.close();
  }
}

async function captureFailureShots(owner, files) {
  fs.mkdirSync(path.dirname(files.compare), { recursive: true });
  if (!fs.existsSync(files.export)) {
    await owner.page
      .screenshot({ path: files.export, fullPage: false })
      .catch(() => {});
  }
  if (!fs.existsSync(files.compare)) {
    await owner.page
      .screenshot({ path: files.compare, fullPage: false })
      .catch(() => {});
  }
}

function emptyPeerMeasure() {
  return {
    fingerprint: null,
    shortAuth: null,
    unavailable: 0,
    qr: 0,
    copy: 0,
    match: 0,
    letIn: 0,
    rowSas: "",
    joinerSas: "",
    compareError: "",
  };
}

export async function capturePeer(browser, dist, device, files) {
  const harness = harnessFor(dist);
  const owner = await openPage(harness, browser, device);
  const measure = emptyPeerMeasure();
  try {
    await ownerEnters(owner.page, {
      origin: ORIGIN,
      base: BASE,
      secret: SECRET,
    });
    const started = await startSession(owner.page);
    const copyKey = await readExportPanel(started.panel, measure);
    await shoot(owner.page, started.panel, files.export);
    if (measure.copy === 0) {
      measure.compareError = "peer trust signal was not copied";
      await shoot(owner.page, started.panel, files.compare);
      return measure;
    }
    const signal = await copyFrom(owner.page, copyKey);
    await compareJoiner({
      owner,
      harness,
      browser,
      device,
      started,
      signal,
      files,
      measure,
    });
  } catch (error) {
    measure.compareError = String(error?.message || error).split("\n")[0];
    log(`peer capture: ${measure.compareError}`);
    await captureFailureShots(owner, files);
    throw error;
  } finally {
    await owner.context.close();
  }
  return measure;
}

/** Walk every side × profile × view, collecting the per-cell measurements. */
export async function walkSides(browser, feature, sides, walkOne, views) {
  const out = {};
  for (const side of sides) {
    out[side.name] = {};
    for (const walk of side.built.walks) {
      const dist = side.built.dists.get(walk.buildKey);
      out[side.name][walk.name] = { note: walk.note, buildKey: walk.buildKey };
      for (const view of views) {
        const dir = path.join(SHOT_ROOT, feature, side.name);
        const stem = `${walk.name}-${view.id}`;
        log(`${feature} ${side.name} ${walk.name} ${view.id}`);
        const files = {
          share: path.join(dir, `${stem}-share.png`),
          ready: path.join(dir, `${stem}-ready.png`),
          export: path.join(dir, `${stem}-export.png`),
          compare: path.join(dir, `${stem}-compare.png`),
        };
        try {
          out[side.name][walk.name][view.id] = await walkOne({
            browser,
            dist,
            view,
            files,
          });
        } catch (error) {
          const message = String(error?.stack || error).slice(0, 1200);
          log(
            `FAIL ${feature} ${side.name} ${walk.name} ${view.id}: ${message}`,
          );
          throw error;
        }
      }
    }
  }
  return out;
}
