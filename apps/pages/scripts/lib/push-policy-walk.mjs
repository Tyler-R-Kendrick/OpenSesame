/**
 * `verify-push.mjs`'s last scenario: a second device whose deployment's
 * operator policy lists one service origin, not the Identity API's. The
 * installation's own egress port refuses before any request leaves, and says
 * so rather than calling the service unreachable.
 */

import { doorGuest } from "./front-door.mjs";
import {
  addCapabilities,
  openSettingsCategory,
  waitOpen,
} from "./pages-journey.mjs";
import { installPushShim } from "./push-browser-shim.mjs";
import { PAGES_ORIGIN } from "./push-stack.mjs";
import { OPERATOR_POLICY } from "./push-verify-kit.mjs";
import {
  trackControlledBirth,
  until,
  untilBornControlled,
} from "./push-worker-harness.mjs";

const TURN_ON = { name: "Turn on push on this device" };

/** `serve(config)` sets what the deployment's `os-runtime-config.json` adds. */
export async function policyWalk({ browser, stack, scope, check, serve }) {
  serve({
    capabilityComposition: {
      schemaVersion: 1,
      instancePolicy: OPERATOR_POLICY,
    },
  });
  const governed = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "allow",
  });
  await governed.grantPermissions(["notifications"], { origin: PAGES_ORIGIN });
  const governedShim = await installPushShim(governed, () =>
    stack.standIn.mint(),
  );
  await trackControlledBirth(governed);
  const second = await governed.newPage();
  const pushCalls = [];
  second.on("request", (request) => {
    if (request.url().includes("/v1/notification-channels/push"))
      pushCalls.push(request.url());
  });
  await second.goto(scope);
  await untilBornControlled(second);
  await doorGuest(second).waitFor({ timeout: 20_000 });
  await doorGuest(second).click();
  await waitOpen(second);
  await addCapabilities(second, ["Push notifications", "Notification routing"]);
  await openSettingsCategory(second, "General");
  await second.getByRole("button", TURN_ON).click();
  await second.getByRole("button", { name: /^Notifications — / }).click();
  const sheet = second.getByRole("dialog", { name: "Notifications" });
  const refused = await until(
    () =>
      sheet
        .locator(".notice-card")
        .filter({ hasText: "Push on this device" })
        .allInnerTexts(),
    (found) => found.length === 1,
    "a notice that this installation may not reach the service",
    10_000,
  );
  check(
    /may not reach the sign-in service for push \(origin-not-allowed\), so notifications were not changed/.test(
      refused[0],
    ),
    `the notice names this installation's policy, not the network (${JSON.stringify(refused[0])})`,
  );
  check(
    !/not reachable/.test(refused[0]),
    "a refusal by policy is not called the service being unreachable",
  );
  check(
    pushCalls.length === 0,
    "no request left for the Identity API's push routes",
  );
  check(
    governedShim.subscribed.length === 0,
    "the browser subscribed to nothing",
  );
  await governed.close();
}
