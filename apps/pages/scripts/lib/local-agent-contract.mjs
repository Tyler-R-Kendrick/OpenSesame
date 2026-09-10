import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { CompactSign, exportJWK, generateKeyPair } from "jose";

const captures = fileURLToPath(
  new URL("../../.impeccable/review/", import.meta.url),
);
mkdirSync(captures, { recursive: true });
async function capture(page, state) {
  await page.screenshot({
    path: `${captures}/agent-${state}-${page.viewportSize().width}.png`,
    fullPage: true,
  });
}

/** Independent agent: private key stays in this test process, never in Pages. */
export async function localAgentContract(page, panel, tabTo) {
  const pair = await generateKeyPair("ES256", { extractable: false });
  const publicKey = await exportJWK(pair.publicKey);
  const summary = panel.locator("summary", { hasText: "Agent keys" });
  await tabTo(page, summary);
  await page.keyboard.press("Enter");
  const enroll = panel.getByRole("button", {
    name: "Enroll public key",
    exact: true,
  });
  await expect(enroll).toBeEnabled();
  await tabTo(page, enroll);
  await page.keyboard.press("Enter");
  const publicInput = panel.getByLabel("Public key JWK", { exact: true });
  await expect(publicInput).toBeFocused();
  await page.keyboard.insertText(JSON.stringify(publicKey));
  await capture(page, "enrollment");
  await tabTo(
    page,
    panel.getByRole("button", { name: "Save public key", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("status", { name: "Agent key status" }),
  ).toHaveText("Agent key enrolled.");
  await expect(enroll).toBeFocused();
  await authenticateAgent(page, panel, tabTo, pair.privateKey);
  await capture(page, "session");
  await tabTo(
    page,
    panel.getByRole("button", { name: "Sign out agent", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("status", { name: "Agent session status" }),
  ).toHaveText("No active local session.");
  await authenticateAgent(page, panel, tabTo, pair.privateKey);
  await tabTo(
    page,
    panel.getByRole("button", { name: "Revoke agent key", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("button", { name: "Confirm key revocation", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("status", { name: "Agent key status" }),
  ).toHaveText("Agent key revoked.");
  await expect(
    panel.getByRole("status", { name: "Agent session status" }),
  ).toHaveText("No active local session.");
  await expect(
    panel.getByRole("button", { name: "Authenticate agent", exact: true }),
  ).toHaveCount(0);
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  console.log(
    "PASS agent key enrollment, signed authentication, sign-out and revocation with real keyboard input",
  );
}

async function authenticateAgent(page, panel, tabTo, privateKey) {
  const authenticate = panel.getByRole("button", {
    name: "Authenticate agent",
    exact: true,
  });
  await tabTo(page, authenticate);
  await page.keyboard.press("Enter");
  const challengeInput = panel.getByLabel("Agent challenge", { exact: true });
  await expect(challengeInput).toBeFocused();
  const challenge = JSON.parse(await challengeInput.inputValue());
  await capture(page, "challenge");
  expect(challenge.origin).toBe(new URL(page.url()).origin);
  const proof = await new CompactSign(
    new TextEncoder().encode(
      JSON.stringify({
        nonce: challenge.nonce,
        principalId: challenge.principalId,
        keyId: challenge.keyId,
        origin: challenge.origin,
        expiresAt: challenge.expiresAt,
      }),
    ),
  )
    .setProtectedHeader({
      alg: "ES256",
      typ: "opensesame-local-agent+jws",
      kid: challenge.keyId,
    })
    .sign(privateKey);
  await tabTo(page, panel.getByLabel("Signed challenge", { exact: true }));
  await page.keyboard.insertText(proof);
  await tabTo(
    page,
    panel.getByRole("button", { name: "Verify agent", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("status", { name: "Agent session status" }),
  ).toHaveText(
    "Signed in locally with an agent key. No human approval or application access was granted.",
  );
  await expect(challengeInput).toHaveCount(0);
  await expect(authenticate).toBeFocused();
}
