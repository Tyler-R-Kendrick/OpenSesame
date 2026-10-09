import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

import { localAccessJourney } from "./lib/local-access-journey.mjs";
import { localDevicesJourney } from "./lib/local-devices-journey.mjs";
import { createLocalIamRig } from "./lib/local-iam-rig.mjs";
import { localPolicyJourney } from "./lib/local-policy-journey.mjs";
import {
  assertConsumedApplicationRequest,
  localRequestJourney,
} from "./lib/local-request-journey.mjs";
import { reviewCaptureDir } from "./lib/review-captures.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const rp = "https://rp.example.test";
const issuerUrl = `${origin}/OpenSesame/identity/authorize`;
const harness = createHarness({
  dist:
    process.env.PAGES_VERIFY_DIST ??
    fileURLToPath(new URL("../dist", import.meta.url)),
  origin,
  base: "/OpenSesame/",
  out: "/tmp/local-iam",
});
const captures = reviewCaptureDir();
const {
  browser,
  authenticator,
  tabTo,
  seedJourney,
  openConsent,
  approveConsent,
} = await createLocalIamRig({ harness, origin, rp, issuerUrl, captures });

async function journey(width, agentMode = false) {
  const { page, context, credentials, identities } =
    await seedJourney(agentMode);
  const { popup, device: popupDevice } = await openConsent(
    page,
    context,
    credentials,
    width,
    agentMode,
  );
  await approveConsent(page, popup, width, agentMode);
  try {
    await expect(page.locator("output")).toHaveText(
      `Signed in locally: ${agentMode ? identities.agent : identities.person}`,
      { timeout: 30_000 },
    );
  } catch (error) {
    console.error(
      "Sign-in failure stage:",
      await page.locator("output").getAttribute("data-reason"),
    );
    throw error;
  }
  await tabTo(page, page.getByRole("button", { name: "Check session" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Session active", {
    timeout: 30_000,
  });
  const updated = await popupDevice.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: popupDevice.authenticatorId,
  });
  await tabTo(page, page.getByRole("button", { name: "Revoke", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Revoked", {
    timeout: 30_000,
  });
  const denied = await openConsent(
    page,
    context,
    updated.credentials,
    width,
    agentMode,
  );
  await tabTo(
    denied.popup,
    denied.popup.getByRole("button", { name: "Deny", exact: true }),
  );
  const deniedWindow = denied.popup.waitForEvent("close");
  await denied.popup.keyboard.press("Enter").catch((error) => {
    if (!denied.popup.isClosed()) throw error;
  });
  await deniedWindow;
  await expect(page.locator("output")).toHaveText("Sign-in refused");
  await assertConsumedApplicationRequest(context, width);
  await assertClockRollbackRefusal(
    page,
    context,
    updated.credentials,
    width,
    agentMode,
  );
  await context.close();
  console.log(
    `PASS ${width}px ${agentMode ? "agent" : "person"}: cross-origin popup, encrypted vault unlock, passkey, consent, PKCE, session check, revocation and denial; fixed wall time, real timers, explicit rollback refusal`,
  );
}

async function assertClockRollbackRefusal(
  page,
  context,
  credentials,
  width,
  agentMode,
) {
  const { popup } = await openConsent(
    page,
    context,
    credentials,
    width,
    agentMode,
  );
  await approveConsent(page, popup, width, agentMode);
  await expect(page.locator("output")).toHaveText(/^Signed in locally: local_/);
  await context.clock.setFixedTime(new Date("2026-09-09T00:00:00Z"));
  await tabTo(page, page.getByRole("button", { name: "Check session" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Session refused");
  await expect(page.locator("output")).toHaveAttribute(
    "data-reason",
    "authorization_unavailable",
  );
}
try {
  for (const width of [1280, 390])
    await localRequestJourney({ width, seedJourney, authenticator, captures });
  for (const width of [1280, 390]) {
    await journey(width);
    await journey(width, true);
    for (const view of ["sessions", "grants"])
      await localAccessJourney({
        width,
        seedJourney,
        openConsent,
        approveConsent,
        captures,
        view,
      });
    await localPolicyJourney({
      width,
      seedJourney,
      openConsent,
      approveConsent,
      captures,
    });
    await localDevicesJourney({
      width,
      seedJourney,
      openConsent,
      approveConsent,
      authenticator,
      captures,
    });
  }
} catch (error) {
  console.error("Local IAM failure:", error);
  for (const [index, context] of browser.contexts().entries()) {
    for (const [tab, page] of context.pages().entries()) {
      console.error(
        "Clock correction in ms:",
        await page
          .evaluate(() =>
            Math.round(Date.now() - performance.timeOrigin - performance.now()),
          )
          .catch(() => "page unavailable"),
      );
      if (new URL(page.url()).origin === rp)
        console.error(
          "RP failure stage:",
          await page.locator("output").getAttribute("data-reason"),
          await page.locator("output").getAttribute("data-proof"),
        );
      await page
        .screenshot({ path: `/tmp/local-iam-failure-${index}-${tab}.png` })
        .catch(() => console.warn("Failure screenshot unavailable"));
    }
  }
  throw error;
} finally {
  await browser.close();
}
if (
  harness.log.some(
    (row) => row.kind === "PAGE-ERROR" || row.kind === "LOOPBACK-REQUEST",
  )
)
  throw new Error("Unexpected browser error or backend request");
