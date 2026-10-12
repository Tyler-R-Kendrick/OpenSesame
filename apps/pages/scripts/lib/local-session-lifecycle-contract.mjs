import { expect } from "@playwright/test";
import {
  openIdentityRecord,
  openIdentityView,
} from "./local-directory-navigation.mjs";

export async function localSessionLifecycleContract(page, panel, tabTo) {
  async function activate(target) {
    await tabTo(page, target);
    await page.keyboard.press("Enter");
  }
  const summary = panel.locator("summary", { hasText: "Passkeys" });
  const signOut = panel.getByRole("button", {
    name: "Sign out locally",
    exact: true,
  });
  const signIn = panel.getByRole("button", {
    name: "Sign in locally",
    exact: true,
  });
  await expect(signOut).toBeEnabled();
  await activate(summary);
  await activate(summary);
  await expect(signOut).toBeEnabled();
  const person = await panel.getByRole("heading", { level: 1 }).innerText();
  await openIdentityView(page, tabTo, "Agents");
  await openIdentityView(page, tabTo, "People");
  await openIdentityRecord(page, tabTo, person);
  await activate(summary);
  await expect(signOut).toBeEnabled();
  await activate(panel.getByRole("button", { name: "Disable", exact: true }));
  await expect(signOut).toBeDisabled();
  await expect(
    panel.getByRole("status", { name: "Local session status" }),
  ).toHaveText("No active local session.");
  await activate(panel.getByRole("button", { name: "Enable", exact: true }));
  await expect(signOut).toBeDisabled();
  await expect(signIn).toBeEnabled();
  await activate(signIn);
  await expect(signOut).toBeEnabled();
  console.log(
    "PASS local session survives disclosure/navigation and revalidates after identity disable/re-enable",
  );
}
