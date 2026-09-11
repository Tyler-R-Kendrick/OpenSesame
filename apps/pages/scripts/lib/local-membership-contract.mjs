import { expect } from "@playwright/test";

export async function localMembershipContract(page, tabTo) {
  async function selectTab(name) {
    await tabTo(page, page.getByRole("tab", { name, exact: true }));
    await page.keyboard.press("Enter");
  }
  async function create(panel, kind, name) {
    await tabTo(
      page,
      panel.getByRole("button", { name: `New ${kind}`, exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("textbox", { name: "Name", exact: true }),
    ).toBeFocused();
    await page.keyboard.type(name);
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
  await selectTab("People");
  const people = page.getByRole("region", {
    name: "Local people",
    exact: true,
  });
  await create(people, "person", "Membership owner");
  await create(people, "person", "Membership member");
  await selectTab("Organization");
  const panel = page.getByRole("region", {
    name: "Local organizations",
    exact: true,
  });
  await create(panel, "organization", "Keyboard organization");
  const org = panel
    .getByRole("listitem")
    .filter({ hasText: "Keyboard organization" });
  const { person, role, rows, disclosure } = await assignOwner(
    page,
    org,
    tabTo,
  );
  await tabTo(page, person);
  await page.keyboard.press("End");
  await expect(role).toHaveValue("member");
  await tabTo(
    page,
    org.getByRole("button", { name: "Add member", exact: true }),
  );
  await page.keyboard.press("Enter");
  const member = rows.filter({ hasText: "Membership member" });
  await expect(member.getByText("member", { exact: true })).toBeVisible();
  await tabTo(page, role);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(role).toHaveValue("admin");
  await tabTo(
    page,
    org.getByRole("button", { name: "Save role", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(member.getByText("admin", { exact: true })).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/opensesame-local-memberships-${page.viewportSize().width}.png`,
  });
  await tabTo(
    page,
    member.getByRole("button", { name: "Remove member", exact: true }),
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(member).toHaveCount(0);
  await expect(disclosure).toBeFocused();
  console.log(
    "PASS keyboard-only organization owner assignment, role update, removal and last-owner refusal",
  );
}

async function assignOwner(page, panel, tabTo) {
  const disclosure = panel.locator("summary", { hasText: "Members" });
  await tabTo(page, disclosure);
  await page.keyboard.press("Enter");
  const person = panel.getByRole("combobox", { name: "Person or agent" });
  const role = panel.getByRole("combobox", { name: "Organization role" });
  await tabTo(page, person);
  await page.keyboard.press("Home");
  for (let step = 0; step < 24; step++) {
    const label = await person.evaluate(
      (node) => node.options[node.selectedIndex]?.text ?? "",
    );
    if (label.startsWith("Membership owner")) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(person.locator("option:checked")).toHaveText(/Membership owner/);
  await expect(role).toHaveValue("owner");
  await tabTo(
    page,
    panel.getByRole("button", { name: "Add member", exact: true }),
  );
  await page.keyboard.press("Enter");
  const rows = panel.locator(".identity-passkeys > li");
  const owner = rows.filter({ hasText: "Membership owner" });
  await expect(owner.getByText("owner", { exact: true })).toBeVisible();
  await tabTo(
    page,
    owner.getByRole("button", { name: "Remove member", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    owner.getByRole("button", { name: "Confirm removal", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("organization owner");
  await expect(owner).toBeVisible();
  return { person, role, rows, disclosure };
}
