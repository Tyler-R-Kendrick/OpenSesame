/**
 * J-APPROVAL (local plane): inbox triage filter is wired through
 * filterInboxRows. Hosted Identity inbox remains absent without a remote
 * session — do not launder verify:local-iam as this walk.
 */
import {
  addCapabilities,
  openSection,
  sealWithPassword,
} from "./pages-journey.mjs";

export async function walkJApproval({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  // Access belongs to a capability: choose it before its rail row exists.
  await addCapabilities(page, ["Access authority"]);
  await openSection(page, "access/");
  await page.getByRole("tab", { name: "Requests", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Local requests",
    exact: true,
  });
  await panel.waitFor({ timeout: 15000 });
  const filter = panel.getByLabel("Local request status filter");
  await filter.waitFor({ timeout: 8000 });
  check((await filter.inputValue()) === "all", "filter defaults to all");
  await filter.selectOption("pending");
  check((await filter.inputValue()) === "pending", "pending filter selectable");
  await filter.selectOption("expired");
  check((await filter.inputValue()) === "expired", "expired filter selectable");
  await filter.selectOption("all");
  check(
    (await page.getByLabel("Approval status filter").count()) === 0,
    "hosted inbox filter is withheld without Identity",
  );
  await snap(page, "J-APPROVAL-local-filter");
}
