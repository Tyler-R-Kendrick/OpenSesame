/** Approved cache plan → physically stopped app socket → real cold SDK reconnect. */
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import ts from "typescript";
import { allowLoopbackDevelopment } from "./local-network-permission.mjs";
import { offlineAppRequests } from "./offline-app-requests.mjs";
import {
  addCapabilities,
  sealWithPin,
  unlockWithPin,
} from "./pages-journey.mjs";
import {
  trackControlledBirth,
  untilBornControlled,
} from "./push-worker-harness.mjs";
import {
  enableBackendConnections,
  newBackendPage,
  visitBackendRoute,
} from "./secret-backend-browser.mjs";

const artifacts = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../src/lib/capabilities/tailscale-artifacts.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function ownedBuiltFile(dist, file) {
  if (!/^assets\/[A-Za-z0-9_.-]+\.js$/.test(file))
    throw new Error("Built worker/controller path is not an owned asset");
  const target = path.join(fs.realpathSync(dist), file);
  const entry = fs.lstatSync(target);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    fs.realpathSync(target) !== target
  )
    throw new Error("Built worker/controller must be a regular owned file");
  return target;
}
function workerURL(node) {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "Worker"
  )
    return null;
  let value = node.arguments?.[0];
  if (
    value &&
    ts.isPropertyAccessExpression(value) &&
    value.name.text === "href"
  )
    value = value.expression;
  if (
    !value ||
    !ts.isNewExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    value.expression.text !== "URL"
  )
    return null;
  return value;
}
function workerAssetReference(node, source, ownerURL, base) {
  const value = workerURL(node);
  if (!value) return null;
  const [literal, origin] = value.arguments ?? [];
  if (
    !literal ||
    !ts.isStringLiteralLike(literal) ||
    !origin ||
    origin.getText(source) !== "import.meta.url"
  )
    return null;
  const reference = literal.text;
  if (
    /[%\\?#]/.test(reference) ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference) ||
    reference.split("/").includes("..")
  )
    return null;
  const url = new URL(reference, ownerURL);
  return url.origin === base.origin && url.pathname.startsWith(base.pathname)
    ? url.pathname.slice(base.pathname.length)
    : null;
}
function emittedWorkerReferences(text, owner, deploymentBase) {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(deploymentBase))
    throw new Error("Built worker deployment base must be an owned path");
  const base = new URL(deploymentBase, "https://artifact.invalid");
  const ownerURL = new URL(owner, base);
  const source = ts.createSourceFile(
    owner,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length)
    throw new Error("Built controller is not valid JavaScript");
  const references = new Set();
  const visit = (node) => {
    const reference = workerAssetReference(node, source, ownerURL, base);
    if (reference) references.add(reference);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}
export function emittedTailnetWorker(
  dist,
  deploymentBase = process.env.VITE_BASE ?? "/OpenSesame/",
) {
  const graph = JSON.parse(
    fs.readFileSync(path.join(dist, "capability-graph.json"), "utf8"),
  );
  const owners = graph.chunks.filter((chunk) =>
    chunk.modules.some((module) =>
      module.id.endsWith("networking.tailnet/browser/controller.ts"),
    ),
  );
  if (!owners.length)
    throw new Error("Built graph has no Tailscale controller owner");
  if (owners.length !== 1)
    throw new Error("Built graph has ambiguous Tailscale controller owners");
  const owner = owners[0];
  const text = fs.readFileSync(ownedBuiltFile(dist, owner.file), "utf8");
  const references = emittedWorkerReferences(text, owner.file, deploymentBase);
  const declared = (graph.workers ?? []).filter(
    (worker) =>
      worker.capability === "networking.tailnet" &&
      worker.variant === "module:tailscale-node" &&
      worker.present === true,
  );
  const files = graph.assets.filter(
    (asset) =>
      /^assets\/tailscale-node-[A-Za-z0-9_-]+\.js$/.test(asset.file) &&
      references.has(asset.file) &&
      declared.filter((worker) => worker.file === asset.file).length === 1,
  );
  if (files.length !== 1)
    throw new Error(
      "Built controller must reference exactly one emitted dedicated worker",
    );
  ownedBuiltFile(dist, files[0].file);
  return files[0].file;
}
async function observeCachePlans(page) {
  await page.addInitScript(() => {
    window.__tailnetCacheMessages = [];
    window.__tailnetPostedPlans = [];
    const send = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (message, ...transfer) {
      if (message?.type === "PLAN_ASSETS")
        window.__tailnetPostedPlans.push(structuredClone(message));
      return send.call(this, message, ...transfer);
    };
    navigator.serviceWorker.addEventListener("message", (event) =>
      window.__tailnetCacheMessages.push(event.data),
    );
  });
}
async function approvedCache(page, networking) {
  await expect
    .poll(
      () =>
        page.evaluate((enabled) => {
          const plan = window.__tailnetPostedPlans.findLast(
            (entry) =>
              entry.moduleIds.includes("connectors.external/runtime") &&
              entry.moduleIds.includes("networking.tailnet/runtime") ===
                enabled,
          );
          return (
            !!plan &&
            window.__tailnetCacheMessages.some(
              (message) =>
                message.type === "OFFLINE_READY" &&
                message.releaseId === plan.releaseId &&
                message.planDigest === plan.planDigest,
            )
          );
        }, networking),
      { timeout: 90_000 },
    )
    .toBe(true);
  return page.evaluate(async (enabled) => {
    const names = (await caches.keys()).filter(
      (name) =>
        name.startsWith("opensesame-pages:") && name.endsWith(":core-only"),
    );
    const urls = (
      await Promise.all(
        names.map(async (name) =>
          (
            await (await caches.open(name)).keys()
          ).map((request) => request.url),
        ),
      )
    ).flat();
    const plan = window.__tailnetPostedPlans.findLast(
      (entry) =>
        entry.moduleIds.includes("connectors.external/runtime") &&
        entry.moduleIds.includes("networking.tailnet/runtime") === enabled,
    );
    return { urls, releaseId: plan.releaseId, planDigest: plan.planDigest };
  }, networking);
}
async function openNode(page, base) {
  await visitBackendRoute(page, base, "settings/connections/tailscale");
  const panel = page.getByRole("region", {
    name: "Tailscale browser node",
    exact: true,
  });
  await panel.waitFor();
  return panel;
}
async function probeDiagnostic(panel, fixture) {
  try {
    const header = panel.page().locator("header.conn-settings__head");
    const [connected, receipt, probeFailed, nodeStopped] = await Promise.all([
      panel.getByRole("img", { name: /^Connected: / }).count(),
      header
        .getByRole("img", { name: "Browser node connected", exact: true })
        .count(),
      panel
        .getByRole("img", {
          name: "The tailnet service request failed. Check the address and try again.",
          exact: true,
        })
        .count(),
      panel
        .getByRole("img", {
          name: "The Tailscale browser node stopped. Check network access and reconnect.",
          exact: true,
        })
        .count(),
    ]);
    return {
      connected: connected > 0,
      receipt: receipt > 0,
      probeFailed: probeFailed > 0,
      nodeStopped: nodeStopped > 0,
      peerRequests: fixture.peer.length,
    };
  } catch {
    return null;
  }
}
async function connectAndProbe(panel, fixture, record) {
  await panel
    .getByRole("button", { name: "Connect browser node", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^Connected: / })
    .waitFor({ timeout: 90_000 });
  await panel
    .getByLabel("Tailnet service URL", { exact: true })
    .fill(fixture.peerUrl);
  const before = await probeDiagnostic(panel, fixture);
  try {
    await panel
      .getByRole("button", { name: "Test tailnet service", exact: true })
      .click();
    await panel
      .getByRole("img", { name: /^HTTP 200 · / })
      .waitFor({ timeout: 45_000 });
  } catch (error) {
    const after = await probeDiagnostic(panel, fixture);
    record("tailnet-probe-failure", JSON.stringify({ before, after }));
    throw error;
  }
}
async function appSocketStopped(origin, base) {
  try {
    await fetch(`${origin}${base}`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return true;
  }
  return false;
}

async function verifyCacheConsent(
  page,
  { origin, base, width, workerAsset, record, check },
) {
  await enableBackendConnections(page, base);
  const baseline = await approvedCache(page, false);
  record("tailnet-unapproved-cache", JSON.stringify(baseline));
  const required = { ...artifacts.assets, worker: workerAsset };
  for (const [kind, asset] of Object.entries(required))
    check(
      !baseline.urls.includes(`${origin}${base}${asset}`),
      `${width}: installed cache excludes unapproved Tailscale ${kind}`,
    );
  await addCapabilities(page, ["Tailnet networking"]);
  const cached = await approvedCache(page, true);
  record("tailnet-installed-cache", JSON.stringify(cached));
  for (const [kind, asset] of Object.entries(required))
    check(
      cached.urls.includes(`${origin}${base}${asset}`),
      `${width}: same-release/digest approved PWA cache includes official Tailscale ${kind} before first SDK connection`,
    );
  return cached;
}

async function stopOwnedApp(
  appServer,
  origin,
  base,
  width,
  requestFailures,
  check,
) {
  await appServer.pause();
  check(
    await appSocketStopped(origin, base),
    `${width}: actual app HTTP socket is closed while real control/DERP/native peer remain live`,
  );
  requestFailures.begin();
}

export async function verifyInstalledTailscalePwa(
  browser,
  { origin, base, width, fixture, appServer, workerAsset, record, check },
) {
  const requestFailures = offlineAppRequests(origin, base);
  const { context, page } = await newBackendPage(browser, {
    width,
    origin,
    providers: [
      fixture.controlUrl,
      "https://derp.fixture.test",
      "https://derp.fixture.test:41917",
    ],
    record,
    serviceWorkers: "allow",
    requestFailures,
  });
  const workers = [];
  page.on("worker", async (worker) => {
    try {
      if ((await worker.evaluate(() => self.name)) === "opensesame-tailscale")
        workers.push(worker.url());
    } catch {
      /* The worker may close during explicit disconnect. */
    }
  });
  try {
    await trackControlledBirth(context);
    await observeCachePlans(page);
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await untilBornControlled(page, 60_000);
    await sealWithPin(page);
    const cached = await verifyCacheConsent(page, {
      origin,
      base,
      width,
      workerAsset,
      record,
      check,
    });
    let panel = await openNode(page, base);
    await panel
      .getByLabel("Browser node hostname", { exact: true })
      .fill(`openss-installed-${width}`);
    await panel
      .getByLabel("Tailscale control server", { exact: true })
      .fill(fixture.controlUrl);
    await panel
      .getByText("Join with an existing auth key", { exact: true })
      .click();
    await panel
      .getByLabel("Optional node auth key", { exact: true })
      .fill(fixture.authKey);
    await connectAndProbe(panel, fixture, record);
    check(
      workers.length > 0 && workers.every((url) => cached.urls.includes(url)),
      `${width}: emitted SDK worker was already in the approved installed cache before first use`,
    );
    await panel
      .getByRole("button", { name: "Disconnect browser node", exact: true })
      .click();
    await stopOwnedApp(appServer, origin, base, width, requestFailures, check);
    await page.reload({ waitUntil: "domcontentloaded" });
    await allowLoopbackDevelopment(page, origin);
    await unlockWithPin(page);
    panel = await openNode(page, base);
    await expect(
      panel.getByLabel("Browser node hostname", { exact: true }),
    ).toHaveValue(`openss-installed-${width}`);
    const before = fixture.peer.length;
    await connectAndProbe(panel, fixture, record);
    check(
      fixture.peer.length > before &&
        (await page.evaluate(() => !!navigator.serviceWorker.controller)),
      `${width}: installed PWA cold-reloads with its app socket stopped, reconnects from vault-held state without another auth key and reaches the real native peer`,
    );
    await panel
      .getByRole("button", { name: "Disconnect browser node", exact: true })
      .click();
  } catch (error) {
    record(
      "tailnet-cache-diagnostics",
      JSON.stringify(
        await page.evaluate(() => ({
          messages: window.__tailnetCacheMessages,
          plans: window.__tailnetPostedPlans,
        })),
      ),
    );
    throw error;
  } finally {
    await context.close();
    requestFailures.end();
    await appServer.resume();
  }
}
