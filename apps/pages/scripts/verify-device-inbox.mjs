// Prove the device's receipts, inbox and local notifications on a static build
// with NO Identity API and NO Host (ADR 0162), under the production origin, at
// desktop and phone width, with the keyboard.
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   pnpm --filter @opensesame/pages verify:device-inbox
//
// Same harness as `verify:local-iam`: every request to the origin is served
// from `dist/`, every other origin is refused, and the run fails on any page
// error or loopback request. Per width, in a password-sealed vault with a
// person, an organization and a registered application:
//
//   A. A locked device shows nothing of what was decided and answers 423 at
//      the plane (`/v1/audit/events`, `/v1/authorization-requests`).
//   B. Nothing has asked the browser for the notification permission by the
//      time two tabs have loaded, and the permission is still "default". The
//      person turns the system doorbell on with the panel's own key; the
//      permission is granted at that press, and that press asks once.
//   C. A request is raised in the front tab. Its record is visible and the title says one waits;
//      a second tab, in the background, shows the bell (the phone's More key),
//      puts `(1)` in its title and rings one system notification whose words
//      are the same for every request and whose data is `{ kind, action, ref }`
//      and nothing a request holds. The front tab rings none (every tab's
//      `Notification` is recorded, so that can fail). A click on the
//      notification and the bell's key each open Access › Requests and leave
//      focus on a visible control.
//   D. The request is approved with the keyboard and the passkey. Every mark
//      goes, and Sessions › Receipts says the request was raised and approved,
//      by the application's name.
//   E. It is withdrawn; a second is refused with the keyboard and the passkey,
//      and told to the second tab again. Receipts say so, the refusal marked
//      denied.
//   F. An application signs in through its own window, and Receipts say so,
//      with no reload; it ends the session, and they say that; a second sign-in
//      is refused in its window, and they say that too; a third is ended by the
//      person in Access › Grants, and Receipts show two sign-ins ended. None of
//      those windows rang a doorbell or marked the tab.
//   G. The plane answers the same trail to a session, holds nothing waiting
//      and no receipt unwritten, refuses to decide, and carries none of what
//      the requests held.
//   H. Locked again, the session answers 423 and the screen holds nothing.
//
// Every wait is for a condition with a stated bound, not for a length of time,
// so the run does not depend on the speed of the machine it is on.
import { fileURLToPath } from "node:url";
import {
  INBOX_CAPABILITIES,
  deviceInboxJourney,
} from "./lib/device-inbox-journey.mjs";
import { createLocalIamRig } from "./lib/local-iam-rig.mjs";
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
  out: "/tmp/device-inbox",
});
const captures = reviewCaptureDir();
const rig = await createLocalIamRig({
  harness,
  origin,
  rp,
  issuerUrl,
  captures,
});

try {
  for (const width of [1280, 390])
    await deviceInboxJourney({
      width,
      rig,
      captures,
      capabilities: INBOX_CAPABILITIES,
    });
} catch (error) {
  console.error(error);
  for (const [index, context] of rig.browser.contexts().entries()) {
    for (const [tab, page] of context.pages().entries()) {
      await page
        .screenshot({
          path: `/tmp/device-inbox-failure-${index}-${tab}.png`,
          timeout: 10000,
        })
        .catch(() => console.warn("Failure screenshot unavailable"));
    }
  }
  throw error;
} finally {
  await rig.browser.close();
}
if (
  harness.log.some(
    (row) => row.kind === "PAGE-ERROR" || row.kind === "LOOPBACK-REQUEST",
  )
)
  throw new Error("Unexpected browser error or backend request");
