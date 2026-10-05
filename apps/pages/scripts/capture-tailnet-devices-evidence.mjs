// Before/after evidence for Identity › Devices (ADR 0168), from two real
// dedicated-origin builds walked the same way on the stack
// `verify:tailnet-devices` runs: an owner seals a vault, turns Identity and
// Networking on, opens Identity › Devices, then presses the panel's add key.
// The branch's build is also paired with the daemon first, as a person
// would; the base's has nothing to pair with, which is the point.
//
//   EVIDENCE_DIST=<base dist-live-dedicated> \
//     node apps/pages/scripts/capture-tailnet-devices-evidence.mjs before
//   node apps/pages/scripts/capture-tailnet-devices-evidence.mjs after
//   node apps/pages/scripts/capture-evidence.mjs compose \
//     docs/evidence/2026-10-05-tailnet-devices/journey.json
//
// Shots land where `capture-evidence.mjs compose` reads them, with a
// `measurements.json` of what the browser counted on each screen.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword } from "./lib/pages-journey.mjs";
import {
  deviceManagementOn,
  pairByLink,
  startStack,
  visit,
} from "./lib/tailnet-devices-stack.mjs";

const side = process.argv[2];
if (side !== "before" && side !== "after") {
  console.error("usage: capture-tailnet-devices-evidence.mjs <before|after>");
  process.exit(2);
}
const out = path.join(os.tmpdir(), "opensesame-evidence", "journey", side);
fs.mkdirSync(out, { recursive: true });
const stack = await startStack({
  out,
  dist: process.env.EVIDENCE_DIST,
  port: Number(process.env.TAILNET_DEVICES_PORT ?? 18793),
});

/** What a person can see and press on the Devices tab, counted by the browser. */
async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const rows = [...main.querySelectorAll(".identity-row")];
    const keys = [...main.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label"),
    );
    const panels = [...main.querySelectorAll("section[aria-label]")].map((s) =>
      s.getAttribute("aria-label"),
    );
    return {
      panels,
      rows: rows.length,
      tailnetMachines: main.querySelectorAll(
        'section[aria-label="Tailnet devices"] .identity-row',
      ).length,
      keys,
    };
  });
}

/** The add key on this build: the tailnet's on the branch, the form on the base. */
async function pressAdd(page) {
  for (const name of ["Add a device", "New device"]) {
    const key = page.getByRole("button", { name, exact: true });
    if ((await key.count()) > 0) {
      await key.first().click();
      await page.waitForTimeout(900);
      return name;
    }
  }
  return null;
}

const measurements = {};
try {
  for (const [width, options] of [
    [1280, { device: { viewport: { width: 1280, height: 900 } } }],
    [390, { device: phoneContext({ width: 390, height: 844 }) }],
  ]) {
    const { page } = await stack.browserPage(options);
    await sealWithPassword(page);
    await deviceManagementOn(page, stack.base);
    if (side === "after")
      await pairByLink(
        page,
        stack.base,
        stack.pairLink("manage", `Evidence ${width}`),
      );
    else await visit(page, stack.base, "identity?view=devices");
    await page.waitForTimeout(2500);
    measurements[`${width}-devices`] = await measure(page);
    await stack.shot(page, `${width}-devices`);
    const pressed = await pressAdd(page);
    measurements[`${width}-add`] = { pressed, ...(await measure(page)) };
    await stack.shot(page, `${width}-add`);
    await page.context().close();
  }
  fs.writeFileSync(
    path.join(out, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  console.log(JSON.stringify(measurements, null, 2));
} finally {
  await stack.close();
}
