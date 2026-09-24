/**
 * J-CONFIG against the built Pages dist: the form → settings/general/
 * config.yaml → a comment and clipboardClearSeconds 30 → write → the form →
 * lock → unlock → reload.
 * Uses a password-sealed vault so lock/unlock is the same tomb (guest
 * isolation would open a different store).
 */
import {
  lockVault,
  openConfigFile,
  openConfigForm,
  openGeneral,
  sealWithPassword,
  unlockWithPassword,
} from "./pages-journey.mjs";

const COMMENT = "# keep this comment through form and lock";
const GENERAL_SOURCE = `${COMMENT}
theme: dark
clipboardClearSeconds: 30
`;
const RAW = 'textarea[aria-label="settings/general/config.yaml"]';

async function setSource(page, yaml) {
  const source = page.locator(RAW);
  await source.waitFor({ timeout: 8000 });
  await source.evaluate((node, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, yaml);
}

async function assertDraft(page, check, label) {
  await openConfigFile(page, "general");
  const source = page.locator(RAW);
  await source.waitFor({ timeout: 8000 });
  await page.waitForFunction(
    ({ selector, comment }) =>
      Boolean(document.querySelector(selector)?.value.includes(comment)),
    { selector: RAW, comment: COMMENT },
  );
  const yaml = await source.inputValue();
  check(yaml.includes(COMMENT), `${label}: comment survived`);
  check(
    yaml.includes("clipboardClearSeconds: 30"),
    `${label}: source clipboard is 30`,
  );
  check(yaml.includes("theme: dark"), `${label}: source theme is dark`);
  await openConfigForm(page, "General");
  const clipboard = page.getByLabel("Clear copied secrets after");
  await clipboard.waitFor({ timeout: 8000 });
  check(
    (await clipboard.inputValue()) === "30",
    `${label}: Form clipboard is 30`,
  );
}

export async function walkJConfig({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  await snap(page, "J-CONFIG-form");
  await page.getByRole("button", { name: "Night" }).click();
  await openConfigFile(page, "general");
  await setSource(page, GENERAL_SOURCE);
  const source = page.locator(RAW);
  check(
    (await source.inputValue()).includes(COMMENT),
    "Source holds the comment before Form",
  );
  await page
    .getByRole("button", { name: "Write settings/general/config.yaml" })
    .click();
  await page
    .locator(".set-raw__status", { hasText: "written" })
    .waitFor({ timeout: 10000 });
  check(true, "the write reported written");
  await openConfigForm(page, "General");
  const clipboard = page.getByLabel("Clear copied secrets after");
  await clipboard.waitFor({ timeout: 8000 });
  check((await clipboard.inputValue()) === "30", "Form shows clipboard 30");
  await snap(page, "J-CONFIG-form-30");
  await lockVault(page);
  await unlockWithPassword(page);
  await openGeneral(page);
  await assertDraft(page, check, "after unlock");
  await snap(page, "J-CONFIG-after-unlock");
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
  await unlockWithPassword(page);
  await openGeneral(page);
  await assertDraft(page, check, "after reload");
  await snap(page, "J-CONFIG-after-reload");
}
