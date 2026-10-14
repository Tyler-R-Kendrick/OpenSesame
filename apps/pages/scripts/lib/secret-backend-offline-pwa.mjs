/** Installed PWA first-use ZIP import; the actual app origin is unavailable throughout. */
import { expect } from "@playwright/test";
import { backupImportFixtures } from "./backup-import-fixtures.mjs";
import { sealWithPin, unlockWithPin } from "./pages-journey.mjs";
import {
  trackControlledBirth,
  untilBornControlled,
} from "./push-worker-harness.mjs";
import {
  connectBackend,
  disconnectBackend,
  enableBackendConnections,
  newBackendPage,
  openBackend,
  saveBackend,
  visitBackendRoute,
} from "./secret-backend-browser.mjs";
import { secretsManagerBrowser } from "./secret-backend-bws-browser.mjs";

async function cachedUrls(page) {
  return page.evaluate(async () => {
    const keys = (await caches.keys()).filter(
      (name) =>
        name.startsWith("opensesame-pages:") && name.endsWith(":core-only"),
    );
    const urls = await Promise.all(
      keys.map(async (name) =>
        (await (await caches.open(name)).keys()).map((request) => request.url),
      ),
    );
    return [...new Set(urls.flat())];
  });
}
async function approveNotes(page, base) {
  await visitBackendRoute(page, base, "settings/vaults#item-types");
  const note = page.getByRole("switch", { name: "Secure note", exact: true });
  await note.waitFor();
  if ((await note.getAttribute("aria-checked")) !== "true") await note.click();
  await expect(note).toHaveAttribute("aria-checked", "true");
  await expect(note).toHaveAttribute("aria-busy", "false");
}
async function installedCacheReady(page, width, check) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const plan = window.__backendPostedPlans.find((entry) =>
            entry.moduleIds.includes("connectors.external/runtime"),
          );
          return (
            !!plan &&
            window.__backendWorkerMessages.some(
              (message) =>
                message.type === "OFFLINE_READY" &&
                message.releaseId === plan.releaseId &&
                message.planDigest === plan.planDigest,
            )
          );
        }),
      { timeout: 90_000 },
    )
    .toBe(true);
  const saved = await cachedUrls(page);
  check(
    saved.length > 10,
    `${width}: installed worker confirms OFFLINE_READY and ${saved.length} actual cached URLs`,
  );
}
async function coldReload(page, context) {
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  // Chromium's COOP target swap resets its CDP offline emulation. The real
  // HTTP origin is already stopped, so this navigation cannot use a fallback.
  await context.setOffline(false);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await unlockWithPin(page);
}
async function firstZipImport(page, { base, origin, preset }) {
  await openBackend(page, base, preset);
  const fixture = backupImportFixtures(origin).find((entry) =>
    entry.file.name.endsWith(".zip"),
  );
  await page
    .getByLabel("Export file", { exact: true })
    .setInputFiles(fixture.file);
  await connectBackend(page);
  await page
    .getByRole("button", { name: "List backend items", exact: true })
    .click();
  await readNotes(page, fixture);
  await page
    .getByRole("button", {
      name: "Import backend items into local vault",
      exact: true,
    })
    .click();
  await page
    .getByRole("img", { name: /^1 items imported; 0 skipped/ })
    .waitFor({ timeout: 30_000 });
  await disconnectBackend(page);
  return fixture;
}
async function readNotes(page, fixture) {
  await page
    .getByRole("button", {
      name: `Read notes for ${fixture.name}`,
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Backend notes", { exact: true })).toHaveValue(
    fixture.notes,
  );
}

export async function coldOfflineBackendImport(
  browser,
  { origin, base, presets, width, record, check, appServer, bws },
) {
  const { context, page } = await newBackendPage(browser, {
    origin,
    width,
    providers: [bws.url],
    record,
    serviceWorkers: "allow",
  });
  try {
    await trackControlledBirth(context);
    await page.addInitScript(() => {
      window.__backendWorkerMessages = [];
      window.__backendPostedPlans = [];
      const send = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, ...transfer) {
        if (message?.type === "PLAN_ASSETS")
          window.__backendPostedPlans.push(structuredClone(message));
        return send.call(this, message, ...transfer);
      };
      navigator.serviceWorker.addEventListener("message", (event) => {
        window.__backendWorkerMessages.push(event.data);
      });
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await untilBornControlled(page, 60_000);
    await sealWithPin(page);
    await enableBackendConnections(page, base);
    await secretsManagerBrowser(page, {
      base,
      server: bws,
      presets,
      width,
      check,
    });
    await approveNotes(page, base);
    const preset = presets.find((entry) => entry.providerId === "proton-pass");
    await openBackend(page, base, preset);
    await saveBackend(page);
    await installedCacheReady(page, width, check);
    await page.waitForLoadState("networkidle");
    await appServer.pause();
    await coldReload(page, context);
    const fixture = await firstZipImport(page, { base, origin, preset });
    await coldReload(page, context);
    await openBackend(
      page,
      base,
      presets.find((entry) => entry.providerId === "local-vault"),
    );
    await saveBackend(page);
    await connectBackend(page);
    await page
      .getByRole("button", { name: "List backend items", exact: true })
      .click();
    await readNotes(page, fixture);
    check(
      await page.evaluate(
        () => !navigator.onLine && !!navigator.serviceWorker.controller,
      ),
      `${width}: installed PWA cold-reloads with its origin stopped, first-use imports Proton ZIP offline, then cold-reloads and reads the persisted note`,
    );
  } catch (error) {
    record(
      "offline-pwa-diagnostics",
      JSON.stringify({
        cached: await cachedUrls(page),
        messages: await page.evaluate(() => window.__backendWorkerMessages),
        postedPlans: await page.evaluate(() => window.__backendPostedPlans),
      }),
    );
    throw error;
  } finally {
    await context.close();
    await appServer.resume();
  }
}
