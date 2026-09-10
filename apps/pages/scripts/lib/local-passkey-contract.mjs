import { expect } from "@playwright/test";
import { localSessionLifecycleContract } from "./local-session-lifecycle-contract.mjs";

export async function localPasskeyContract(page, panel, tabTo) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  try {
    await tabTo(page, panel.locator("summary", { hasText: "Passkeys" }));
    await page.keyboard.press("Enter");
    const enroll = panel.getByRole("button", {
      name: "Enroll passkey",
      exact: true,
    });
    await expect(enroll).toBeEnabled();
    await tabTo(page, enroll);
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("status", { name: "Passkey status" }),
    ).toContainText("Passkey enrolled.");
    await tabTo(
      page,
      panel.getByRole("button", { name: "Sign in locally", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("status", { name: "Local session status" }),
    ).toContainText("Signed in locally with a passkey.");
    await localSessionLifecycleContract(page, panel, tabTo);
    await tabTo(
      page,
      panel.getByRole("button", { name: "Sign out locally", exact: true }),
    );
    await page.screenshot({
      path: `/tmp/opensesame-local-passkeys-${page.viewportSize().width}.png`,
    });
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("status", { name: "Local session status" }),
    ).toContainText("No active local session.");
    await tabTo(
      page,
      panel.getByRole("button", { name: "Sign in locally", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("button", { name: "Sign out locally", exact: true }),
    ).toBeEnabled();
    await revokePasskey(page, panel, tabTo);
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.detach();
  }
  console.log(
    "PASS real browser WebAuthn enrollment, verification and revocation without a backend",
  );
}

async function revokePasskey(page, panel, tabTo) {
  await tabTo(
    page,
    panel.getByRole("button", { name: "Revoke passkey", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("button", { name: "Confirm revocation", exact: true }),
  ).toBeFocused();
  await tabTo(
    page,
    panel.getByRole("button", { name: "Keep passkey", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("button", { name: "Revoke passkey", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    panel.getByRole("button", { name: "Confirm revocation", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("status", { name: "Passkey status" }),
  ).toContainText("Passkey revoked.");
  await expect(
    panel.getByRole("button", { name: "Sign out locally", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("status", { name: "Local session status" }),
  ).toHaveText("No active local session.");
  await expect(panel.locator("summary", { hasText: "Passkeys" })).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Sign in locally", exact: true }),
  ).toBeDisabled();
  await tabTo(page, panel.locator("summary", { hasText: "Passkeys" }));
  await page.keyboard.press("Enter");
}
