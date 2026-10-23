/**
 * Trusted contacts (ADR 0187) under a finger: the Settings tab, each head key
 * and the sheet it opens, measured against the touch contract by the walk's own
 * `audit` — the 44px keys, the 16px fields, nothing floating over a control, no
 * strip hiding its own selection.
 *
 * Guest, decoy and locked vaults draw no panel, so the walk seals a vault with
 * a PIN first (the door's no-account road), chooses the capability the way a
 * person does, and then opens the tab. Nothing here saves a circle: people
 * first need enrolled passkeys in Identity. What a phone has to hold is the
 * local-circle form, including its name, people and disabled save key when
 * no enrolled people have been selected.
 */
import { chooseCapabilitiesHere } from "./mobile-capabilities.mjs";
import { sealWithPin } from "./mobile-protector-unlock.mjs";

const KEYS = [["Start a circle", "circle"]];

/**
 * Close whatever sheet is open. Escape leaves a text field for its sheet before
 * it closes the sheet, so a second press follows when one is still there.
 */
async function closeSheet(page) {
  for (let press = 0; press < 2; press++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
    if ((await page.getByRole("dialog").count()) === 0) return;
  }
}

/** The Security subsection, reached the way a thumb does. */
async function openSettingsTab(page, { harness, openTab, stop }) {
  await openTab(page, "Settings");
  await page.waitForTimeout(700);
  const security = page
    .getByRole("link", { name: "Security", exact: true })
    .first();
  if ((await security.count()) === 0) {
    harness.check(false, `${stop("trusted-contacts")}: Security is not drawn`);
    return false;
  }
  await security.tap();
  await page.waitForTimeout(700);
  const link = page
    .getByRole("link", { name: "Trusted contacts", exact: true })
    .first();
  if ((await link.count()) === 0) {
    harness.check(
      false,
      `${stop("trusted-contacts")}: the subsection is not drawn`,
    );
    return false;
  }
  await link.tap();
  await page.waitForTimeout(900);
  return true;
}

/** Tap the head key, audit the sheet it opens, and say so when it is absent. */
async function auditSheet(page, name, label, { harness, audit, stop }) {
  const key = page.getByRole("button", { name, exact: true }).first();
  if ((await key.count()) === 0) {
    harness.check(false, `${stop(label)}: "${name}" is not on the panel`);
    return false;
  }
  await key.tap();
  await page.waitForTimeout(650);
  await audit(page, stop(label));
  return true;
}

/** The local unlock circle: a name and enrolled people, never copied packets. */
async function circleForm(page, run) {
  const { harness, audit, stop } = run;
  const form = page.getByRole("form", { name: "Trusted contacts circle" });
  await form.waitFor();
  const name = form.getByLabel("Name", { exact: true });
  await name.fill("Family");
  harness.check(
    (await name.inputValue()) === "Family",
    `${stop("trusted-contacts-form")}: the circle name can be entered`,
  );
  harness.check(
    (await form.getByRole("group", { name: "People", exact: true }).count()) ===
      1,
    `${stop("trusted-contacts-form")}: the circle's people are grouped and named`,
  );
  harness.check(
    (await form
      .getByRole("img", {
        name: "Add a person with a passkey in Identity first.",
        exact: true,
      })
      .count()) === 1,
    `${stop("trusted-contacts-form")}: an empty directory explains how to enroll people`,
  );
  harness.check(
    await form
      .getByRole("button", { name: "Save the circle", exact: true })
      .isDisabled(),
    `${stop("trusted-contacts-form")}: a circle cannot be saved without people`,
  );
  await audit(page, stop("trusted-contacts-form"));
}

export async function trustedContactsStops(
  page,
  { harness, audit, openTab: toSection, stop, origin, base },
) {
  const run = { harness, audit, stop, openTab: toSection };
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await chooseCapabilitiesHere(page, ["Trusted contacts"], {
    harness,
    openTab: toSection,
  });
  if (!(await openSettingsTab(page, run))) return;
  await audit(page, stop("trusted-contacts"));
  for (const [name, label] of KEYS) {
    if (!(await auditSheet(page, name, `trusted-contacts-${label}`, run)))
      continue;
    if (label === "circle") await circleForm(page, run);
    await closeSheet(page);
  }
}
