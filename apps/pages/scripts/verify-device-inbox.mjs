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
//   B. A request is raised in the front tab. The Requests tab says one waits;
//      a second tab, in the background, shows the bell (the phone's More key),
//      puts `(1)` in its title and rings one system notification whose words
//      are the same for every request and whose data is `{ kind, action, ref }`
//      and nothing a request holds. The front tab rings none. The bell's key
//      opens Access › Requests.
//   C. The request is approved with the keyboard and the passkey. Every mark
//      goes, and Sessions › Receipts says the request was raised and approved,
//      by the application's name.
//   D. It is withdrawn; a second is refused with the keyboard and the passkey,
//      and told to the second tab again. Receipts say so, the refusal marked
//      denied.
//   E. An application signs in through its own window, and Receipts say so,
//      with no reload; it ends the session, and they say that; a second sign-in
//      is refused in its window, and they say that too.
//   F. The plane answers the same trail to a session, holds nothing waiting,
//      refuses to decide, and carries none of what the requests held.
//   G. Locked again, the session answers 423 and the screen holds nothing.
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
  dist: fileURLToPath(new URL("../dist", import.meta.url)),
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
  for (const [index, context] of rig.browser.contexts().entries()) {
    for (const [tab, page] of context.pages().entries()) {
      await page
        .screenshot({ path: `/tmp/device-inbox-failure-${index}-${tab}.png` })
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
