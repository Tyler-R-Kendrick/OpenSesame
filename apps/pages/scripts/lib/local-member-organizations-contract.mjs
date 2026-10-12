import { expect } from "@playwright/test";
import {
  openIdentityRecord,
  openIdentityView,
} from "./local-directory-navigation.mjs";

// The directory's own refusal (`requireOwners`,
// packages/app-core/src/lib/local-directory-memberships.ts).
const LAST_OWNER =
  "Keep an enabled person as organization owner before removing or disabling the last owner.";

/**
 * The member's own view (ADR 0105): the organization's owner signs in with a
 * real passkey, finds the organization under their session, opens it and
 * works its keys by keyboard — the role select, Save role, and the armed
 * removal with Keep member. As its only owner, both edits meet the
 * directory's last-owner refusal, shown as a mark; the session survives,
 * because nothing was committed.
 */
export async function localMemberOrganizationsContract(page, tabTo) {
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
    const person = await signInOwner(page, tabTo);
    const orgs = person.getByRole("region", { name: "Organizations" });
    // Promoting the first claimed owner also hands the guest's own Personal
    // organization to them (local-directory-memberships.ts), so the count is
    // the directory's to say; the organization this walk made must be there.
    await expect(
      orgs.getByRole("img", { name: /^Member of \d+ organizations?\.$/ }),
    ).toBeVisible();
    const summary = orgs.locator("summary", {
      hasText: "Keyboard organization",
    });
    await tabTo(page, summary);
    await page.keyboard.press("Enter");
    await expect(orgs.getByRole("img", { name: "1 member." })).toBeVisible();
    // The demotion meets a fresh mark; the removal after it is proved by
    // the row and the session surviving — a committed edit would have
    // ended the session (ADR 0104 revision binding).
    await demotionRefused(page, orgs, tabTo);
    await removalRefused(page, orgs, tabTo);
    await expect(summary).toContainText("Owner (operator)");
    await expect(
      person.getByRole("button", { name: "Sign out locally", exact: true }),
    ).toBeEnabled();
    await orgs.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/opensesame-member-organizations-${page.viewportSize().width}.png`,
    });
    await tabTo(
      page,
      person.getByRole("button", { name: "Sign out locally", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(orgs).toHaveCount(0);
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.detach();
  }
  console.log(
    "PASS keyboard-only member view: a passkey session opens its organization, tries a role change and an armed, kept and confirmed removal, and meets the last-owner refusal as a mark each time",
  );
}

async function signInOwner(page, tabTo) {
  await openIdentityView(page, tabTo, "People");
  await openIdentityRecord(page, tabTo, "Membership owner");
  const person = page.locator(".record-workspace .vault__detail");
  await tabTo(page, person.locator("summary", { hasText: "Passkeys" }));
  await page.keyboard.press("Enter");
  const enroll = person.getByRole("button", {
    name: "Enroll passkey",
    exact: true,
  });
  await expect(enroll).toBeEnabled();
  await tabTo(page, enroll);
  await page.keyboard.press("Enter");
  await expect(
    person.getByRole("status", { name: "Passkey status" }),
  ).toContainText("Passkey enrolled.");
  await tabTo(
    page,
    person.getByRole("button", { name: "Sign in locally", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    person.getByRole("status", { name: "Local session status" }),
  ).toContainText("Signed in locally with a passkey.");
  return person;
}

async function removalRefused(page, orgs, tabTo) {
  const remove = orgs.getByRole("button", {
    name: "Remove member",
    exact: true,
  });
  await tabTo(page, remove);
  await page.keyboard.press("Enter");
  const confirm = orgs.getByRole("button", {
    name: "Confirm removal",
    exact: true,
  });
  await expect(confirm).toBeFocused();
  await tabTo(page, orgs.getByRole("button", { name: "Keep member" }));
  await page.keyboard.press("Enter");
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(orgs.getByRole("img", { name: LAST_OWNER })).toBeVisible();
  await expect(orgs.getByRole("alert")).toHaveText(LAST_OWNER);
  await expect(orgs.locator(".note")).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(
    orgs.getByText("Membership owner", { exact: true }),
  ).toBeVisible();
}

async function demotionRefused(page, orgs, tabTo) {
  const select = orgs.getByRole("combobox", {
    name: "Role for Membership owner",
  });
  const save = orgs.getByRole("button", { name: "Save role", exact: true });
  await expect(save).toBeDisabled();
  await tabTo(page, select);
  await page.keyboard.press("Home");
  await expect(select).toHaveValue("member");
  await expect(save).toBeEnabled();
  await tabTo(page, save);
  await page.keyboard.press("Enter");
  await expect(orgs.getByRole("img", { name: LAST_OWNER })).toBeVisible();
  await expect(save).toBeFocused();
}
