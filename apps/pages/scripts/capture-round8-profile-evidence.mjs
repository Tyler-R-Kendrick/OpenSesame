/**
 * Round 8 install-profile galleries for P8-1 and P8-2.
 *
 * Each profile dist is `security-profile.mjs` then `vite build` with
 * `VITE_BASE=/OpenSesame/`; `default` and `custom` share the stock build.
 * The capture plan is `lib/round8-profile-plan.mjs`, the worktrees and
 * builds `lib/round8-profile-trees.mjs`, the browser walks
 * `lib/round8-profile-capture.mjs` and the sheets
 * `lib/round8-gallery-sheets.mjs`.
 *
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     node apps/pages/scripts/capture-round8-profile-evidence.mjs
 *
 * `VERIFY_SKIP_BUILD=1` reuses a dist that already has index.html.
 * `ROUND8_ONLY=p8-1` or `p8-2` captures one gallery.
 */

import { execFileSync } from "node:child_process";
import { devices } from "@playwright/test";
import {
  dropSheets,
  emitGallery,
  peerSheets,
} from "./lib/round8-gallery-sheets.mjs";
import {
  harnessFor,
  launchBrowser,
  openPage,
  requireChromium,
} from "./lib/round8-profile-browser.mjs";
import {
  captureDrop,
  capturePeer,
  walkSides,
} from "./lib/round8-profile-capture.mjs";
import {
  P8_1_AFTER,
  P8_1_BEFORE,
  REPO,
  log,
  selectedFeatures,
  shasFor,
} from "./lib/round8-profile-plan.mjs";
import { buildsFor, ensureTree, tipSha } from "./lib/round8-profile-trees.mjs";
import { WALK_NAMES } from "./lib/verification-checklist-profiles.mjs";

const PHONE = devices["iPhone 13"];

const VIEWS = Object.freeze([
  {
    id: "1280",
    width: 1280,
    height: 900,
    desktop: true,
    device: {
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
  {
    id: "390",
    width: 390,
    height: 844,
    desktop: false,
    device: {
      userAgent: PHONE.userAgent,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    },
  },
]);

async function captureDropWalk({ browser, dist, view, files }) {
  const opened = await openPage(harnessFor(dist), browser, view.device);
  try {
    return await captureDrop(opened.page, files);
  } finally {
    await opened.context.close();
  }
}

function capturePeerWalk({ browser, dist, view, files }) {
  return capturePeer(browser, dist, view.device, files);
}

const FEATURES = Object.freeze({
  "p8-1": {
    title: "Portable drop on four install profiles",
    folder: "2026-10-17-p8-1-portable-drop-profiles",
    sheetsOf: dropSheets,
    walkOne: captureDropWalk,
  },
  "p8-2": {
    title: "Peer trust on four install profiles",
    folder: "2026-10-17-p8-2-peer-trust-profiles",
    sheetsOf: peerSheets,
    walkOne: capturePeerWalk,
  },
});

async function runFeature(browser, builtBySha, feature, beforeSha, afterSha) {
  const spec = FEATURES[feature];
  const before = { name: "before", built: builtBySha.get(beforeSha) };
  const after = { name: "after", built: builtBySha.get(afterSha) };
  const captured = await walkSides(
    browser,
    feature,
    [before, after],
    spec.walkOne,
    VIEWS,
  );
  await emitGallery({
    browser,
    feature,
    title: spec.title,
    folder: spec.folder,
    beforeSha,
    afterSha,
    walks: before.built.walks,
    captured,
    sheetsOf: spec.sheetsOf,
    views: VIEWS,
  });
}

async function main() {
  requireChromium();
  if (WALK_NAMES.length !== 4) {
    throw new Error(`expected four walk names, got ${WALK_NAMES.join(",")}`);
  }
  const afterP2 = tipSha();
  const features = selectedFeatures(process.env.ROUND8_ONLY);
  const builtBySha = new Map();
  for (const sha of shasFor(features, afterP2)) {
    builtBySha.set(sha, buildsFor(ensureTree(sha)));
  }
  const browser = await launchBrowser();
  try {
    if (features.includes("p8-1")) {
      await runFeature(browser, builtBySha, "p8-1", P8_1_BEFORE, P8_1_AFTER);
    }
    if (features.includes("p8-2")) {
      await runFeature(browser, builtBySha, "p8-2", P8_1_AFTER, afterP2);
    }
  } finally {
    await browser.close();
  }
  execFileSync("node", ["scripts/quality/docs-index.mjs"], {
    cwd: REPO,
    stdio: "inherit",
  });
  log("done");
}

await main();
