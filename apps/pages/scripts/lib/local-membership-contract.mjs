import { expect } from "@playwright/test";

// The refusal a guest meets once a claimed operator exists
// (`assertAccessCapability`, packages/app-core/src/lib/local-rbac.ts).
const OPERATOR_ONLY =
  "Only an operator can change Access or Identity administration once an operator identity is assigned.";

async function selectTab(page, tabTo, name) {
  await tabTo(page, page.getByRole("tab", { name, exact: true }));
  await page.keyboard.press("Enter");
}

function organizationsPanel(page) {
  return page.getByRole("region", {
    name: "Local organizations",
    exact: true,
  });
}

/** People and an organization, created while the guest is still operator. */
export async function localMembershipSetup(page, tabTo) {
  async function create(panel, kind, name) {
    const createButton = panel.getByRole("button", {
      name: `New ${kind}`,
      exact: true,
    });
    await expect(createButton).toBeEnabled();
    await tabTo(page, createButton);
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
  await selectTab(page, tabTo, "People");
  const people = page.getByRole("region", {
    name: "Local people",
    exact: true,
  });
  await create(people, "person", "Membership owner");
  await create(people, "person", "Membership member");
  await selectTab(page, tabTo, "Organizations");
  await create(
    organizationsPanel(page),
    "organization",
    "Keyboard organization",
  );
}

/**
 * The guest assigns the organization's first owner by keyboard. That owner is
 * a claimed operator, so from then on the guest holds no Access capability:
 * removing the owner and adding a member are both refused, and the directory
 * is left as it was.
 */
export async function localMembershipContract(page, tabTo) {
  await selectTab(page, tabTo, "Organizations");
  const panel = organizationsPanel(page);
  const org = panel
    .getByRole("listitem")
    .filter({ hasText: "Keyboard organization" });
  const { person, role, rows, disclosure, owner } = await assignOwner(
    page,
    org,
    tabTo,
  );
  await tabTo(
    page,
    owner.getByRole("button", { name: "Remove member", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    owner.getByRole("button", { name: "Confirm removal", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(OPERATOR_ONLY);
  await expect(disclosure).toBeFocused();
  await expect(owner).toContainText("Owner (operator)");
  await tabTo(page, person);
  await page.keyboard.press("End");
  await expect(person.locator("option:checked")).toHaveText(
    /Membership member/,
  );
  await expect(role).toHaveValue("member");
  await tabTo(
    page,
    org.getByRole("button", { name: "Add member", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(OPERATOR_ONLY);
  await expect(rows.filter({ hasText: "Membership member" })).toHaveCount(0);
  await expect(owner).toContainText("Owner (operator)");
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/opensesame-local-memberships-${page.viewportSize().width}.png`,
  });
  console.log(
    "PASS keyboard-only organization owner assignment, then the guest's removal and membership changes refused",
  );
}

async function selectOption(page, select, name) {
  await page.keyboard.press("Home");
  for (let step = 0; step < 24; step++) {
    const label = await select.evaluate(
      (node) => node.options[node.selectedIndex]?.text ?? "",
    );
    if (label.startsWith(name)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(select.locator("option:checked")).toHaveText(new RegExp(name));
}

async function assignOwner(page, panel, tabTo) {
  const disclosure = panel.locator("summary", { hasText: "Members" });
  await tabTo(page, disclosure);
  await page.keyboard.press("Enter");
  const person = panel.getByRole("combobox", { name: "Person or agent" });
  const role = panel.getByRole("combobox", { name: "Organization role" });
  await tabTo(page, person);
  await selectOption(page, person, "Membership owner");
  await page.keyboard.press("Tab");
  await expect(role).toBeFocused();
  await expect(role).toHaveValue("owner");
  const addMember = panel.getByRole("button", {
    name: "Add member",
    exact: true,
  });
  await expect(addMember).toBeEnabled();
  await tabTo(page, addMember);
  await expect(addMember).toBeFocused();
  await page.keyboard.press("Enter");
  const rows = panel.locator(".identity-passkeys > li");
  const owner = rows.filter({ hasText: "Membership owner" });
  await expect(owner).toBeVisible();
  await expect(owner).toContainText("Owner (operator)");
  return { person, role, rows, disclosure, owner };
}
