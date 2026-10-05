// Tailnet device management, end to end (ADR 0169): a real `opensesame`
// daemon holding the tailnet credential, a stand-in for api.tailscale.com
// (`lib/tailscale-stub.mjs`), and the built page, which never sees the
// credential.
//
//   cargo build -p opensesame-cli --features tailnet-admin-test-upstream
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build:live-dedicated
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:tailnet-devices
//
// The page is the deployment of one's own (`dedicated_origin`): the shared
// GitHub Pages origin may not hold tailnet authority at all, and says so
// (TD-SHARED, against `dist/` when it is there). The daemon runs on loopback with a throwaway state directory and the stub
// as its Tailscale API (`OPENSESAME_TAILSCALE_API_BASE`, read only by a build
// with that feature). The operator side is the CLI a person runs: `daemon
// tailnet connect`, `pair`, `unpair`. Each browser is its own context, served
// `dist/` under the production origin.
//
//   TD-PAIR     an owner opens the link `pair` printed: the sheet opens with
//               the code, the commit pairs, and the tailnet's four machines
//               are listed, the one waiting for approval first
//   TD-APPROVE  approving it reaches Tailscale, and its mark goes
//   TD-EDIT     a rename, a tag and the exit node, saved together, reach
//               Tailscale as three calls; a tag the policy does not own is
//               refused with Tailscale's words
//   TD-ADD      Add a device mints a pre-approved, tagged auth key; a machine
//               joins with it and is listed, tagged and approved
//   TD-EXPIRE   expiring a key, revoking an auth key and removing a machine
//               each take two presses and each reach Tailscale
//   TD-AUDIT    the Activity list and the daemon's own log name each change
//               and the pairing that made it; no credential or auth key is in
//               the daemon's state, the page's storage or the log
//   TD-READ     a phone paired read-only sees the same tailnet and holds no
//               key that changes it; `unpair --all` cuts it off
//   TD-FORGET   the owner forgets the pairing; the panel offers pairing only
//
// Screenshots land in $TAILNET_DEVICES_OUT (default: the system temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import "./lib/expect-timeout.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword } from "./lib/pages-journey.mjs";
import {
  deviceManagementOn,
  pairByLink,
  startStack,
  until,
} from "./lib/tailnet-devices-stack.mjs";
import {
  approve,
  editPangolin,
  mintAndJoin,
  removeAndRevoke,
} from "./lib/tailnet-devices-steps.mjs";
import { API_TOKEN } from "./lib/tailscale-stub.mjs";

const out =
  process.env.TAILNET_DEVICES_OUT ??
  fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-devices-"));
const stack = await startStack({
  out,
  port: Number(process.env.TAILNET_DEVICES_PORT ?? 18792),
});
const { base, state, stub, shot } = stack;

/**
 * The daemon's state, but its credential file: the one file the API token may
 * be in (0600 in a 0700 directory). Nothing else it writes holds a token, a
 * minted key or a bearer.
 */
function stateFiles() {
  const secret = path.join(state, "tailnet-admin.secret");
  if ((fs.statSync(secret).mode & 0o077) !== 0)
    throw new Error("the credential file is readable by others");
  if ((fs.statSync(state).mode & 0o077) !== 0)
    throw new Error("the state directory is open to others");
  return fs
    .readdirSync(state)
    .filter((name) => name !== "tailnet-admin.secret")
    .map((name) => fs.readFileSync(path.join(state, name), "utf8"))
    .join("\n");
}

let failed = false;
try {
  // TD-PAIR
  const owner = await stack.browserPage({
    device: { viewport: { width: 1280, height: 900 } },
  });
  const page = owner.page;
  await sealWithPassword(page);
  await deviceManagementOn(page, base);
  await pairByLink(page, base, stack.pairLink("manage", "Ops laptop"));
  const rows = page
    .getByRole("region", { name: "Tailnet devices" })
    .getByRole("heading", { level: 3 });
  await expect(rows).toHaveCount(4, { timeout: 20_000 });
  await expect(rows.first()).toHaveText("sams-phone");
  console.log("TD-PAIR ok");
  await shot(page, "1280-paired");

  const steps = { page, stub, shot, until };
  await approve(steps);
  await editPangolin(steps);
  const minted = await mintAndJoin(steps);
  await removeAndRevoke(steps);

  // TD-AUDIT
  const activity = page.getByRole("region", { name: "Tailnet activity" });
  for (const said of [
    "Approved sams-phone",
    "Renamed web-01",
    "Tagged web-01",
    "Changed routes of web-01",
    "Minted the auth key",
    "Revoked the auth key",
    "Removed",
  ])
    await expect(activity.getByText(said).first()).toBeVisible();
  const kept = stateFiles();
  // The trail rests sealed; the operator reads it back through the CLI.
  const trail = stack.cli("audit");
  if (!trail.includes("device.authorize") || !trail.includes("Ops laptop"))
    throw new Error("TD-AUDIT: the daemon's log is missing the approval");
  const rest = fs
    .readFileSync(path.join(state, "tailnet-admin-audit.jsonl"), "utf8")
    .trim()
    .split("\n");
  if (!rest.every((line) => line.startsWith("osl1.")))
    throw new Error("TD-AUDIT: the audit trail rests in the clear");
  if (kept.includes(minted) || kept.includes(API_TOKEN) || /tskey-/.test(kept))
    throw new Error("TD-AUDIT: a key or credential is in the daemon's state");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  if (stored.includes("tskey-")) throw new Error("TD-AUDIT: key in storage");
  console.log("TD-AUDIT ok");
  await shot(page, "1280-activity");

  // TD-READ
  const phone = await stack.browserPage({
    device: phoneContext({ width: 390, height: 844 }),
  });
  await sealWithPassword(phone.page);
  await deviceManagementOn(phone.page, base);
  await pairByLink(phone.page, base, stack.pairLink("read", "Help desk phone"));
  const phoneRows = phone.page
    .getByRole("region", { name: "Tailnet devices" })
    .getByRole("heading", { level: 3 });
  await expect(phoneRows.first()).toBeVisible({ timeout: 20_000 });
  for (const name of [/^Add a device$/, /^Approve /, /^Remove /, /^Revoke /])
    await expect(phone.page.getByRole("button", { name })).toHaveCount(0);
  await shot(phone.page, "390-read-only");
  stack.cli("unpair", "--all");
  await phone.page
    .getByRole("button", { name: "Reload tailnet devices" })
    .click();
  await expect(phone.page.getByRole("alert")).toContainText(
    "no longer knows this page's key",
    { timeout: 20_000 },
  );
  console.log("TD-READ ok");
  await shot(phone.page, "390-unpaired");

  // TD-FORGET — the owner's pairing went with `--all`; forgetting it here
  // clears the sealed copy, and the panel offers pairing again.
  await page
    .getByRole("button", { name: "Forget this daemon's pairing" })
    .click();
  await page
    .getByRole("button", { name: "Confirm forgetting this daemon's pairing" })
    .click();
  await expect(
    page.getByRole("button", { name: "Pair with the tailnet daemon" }),
  ).toBeVisible({ timeout: 20_000 });
  console.log("TD-FORGET ok");

  const errors = [...owner.errors, ...phone.errors];
  if (errors.length > 0) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("verify:tailnet-devices PASS");
} catch (error) {
  failed = true;
  console.error(`verify:tailnet-devices FAIL — ${error.stack ?? error}`);
  for (const [n, page] of stack.pages.entries()) {
    await shot(page, `failure-${n}`).catch(() => undefined);
  }
  console.error(
    "Tailscale saw:",
    stub.tailnet.calls.map((c) => `${c.method} ${c.path}`).join("\n  "),
  );
} finally {
  await stack.close();
}
process.exit(failed ? 1 : 0);
