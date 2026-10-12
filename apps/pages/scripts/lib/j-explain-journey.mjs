/**
 * J-EXPLAIN: Application Diagnostics uses the same evaluator as admission;
 * a saved failing policy test blocks candidate publication.
 */
import { addCapabilities, sealWithPin } from "./pages-journey.mjs";
import { expectInTray } from "./tray-contract.mjs";

import { createApplication, openApplications } from "./j-local-application.mjs";

export async function walkJExplain({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  // Identity belongs to a capability: choose it before its rail row exists.
  await addCapabilities(page, [
    "External connectors",
    "Access authority",
    "Browser-local IAM",
    "Directory provisioning",
  ]);
  await openApplications(page);
  const row = await createApplication(page, "Explain relying party");
  await row.getByRole("heading", { name: "Diagnostics" }).waitFor({
    timeout: 10000,
  });
  await row.getByLabel("Simulated role").selectOption("member");
  await row.getByLabel("Requested scopes").fill("openid");
  await page.waitForTimeout(200);
  const decision = await row
    .locator("p")
    .filter({ hasText: /^Decision:/ })
    .innerText();
  check(
    /Decision:\s*(deny|allow|indeterminate)/i.test(decision),
    `decision shown: ${decision}`,
  );
  // Expect allow while member+openid on an empty policy is deny/indeterminate.
  await row.getByLabel("Expected decision").selectOption("allow");
  await row.getByRole("button", { name: "Save as policy test" }).click();
  await expectInTray(page, /Candidate publication is blocked/i);
  check(true, "failing saved test blocks publication");
  await snap(page, "J-EXPLAIN-diagnostics");
}
