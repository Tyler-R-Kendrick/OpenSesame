/**
 * Trusted contacts (ADR 0187) under a finger: the Settings tab, each head key
 * and the sheet it opens, measured against the touch contract by the walk's own
 * `audit` — the 44px keys, the 16px fields, nothing floating over a control, no
 * strip hiding its own selection.
 *
 * Guest, decoy and locked vaults draw no panel, so the walk seals a vault with
 * a PIN first (the door's no-account road), chooses the capability the way a
 * person does, and then opens the tab. Nothing here makes a circle: a circle
 * needs other people's packets, and `verify:trusted-contacts` walks that with
 * five browsers. What a phone has to hold is the empty tab, the five sheets,
 * the new-circle sheet's second step (an invitation and its QR code), and a
 * refused paste.
 */
import { chooseCapabilitiesHere } from "./mobile-capabilities.mjs";
import { sealWithPin } from "./mobile-protector-unlock.mjs";

const KEYS = [
  ["Start a circle", "circle"],
  ["Accept an invitation", "accept"],
  ["Take what an owner sent", "take"],
  ["Answer a request", "answer"],
  ["Start a recovery", "recovery"],
];

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

/** The Settings tab, reached the way a thumb does. */
async function openSettingsTab(page, { harness, openTab, stop }) {
  await openTab(page, "Settings");
  await page.waitForTimeout(700);
  const link = page
    .getByRole("link", { name: "Trusted contacts", exact: true })
    .first();
  if ((await link.count()) === 0) {
    harness.check(false, `${stop("trusted-contacts")}: the tab is not drawn`);
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

/** The new-circle sheet's next step: a name, then the invitation to hand on. */
async function invitationStep(page, run) {
  const { harness, audit, stop } = run;
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Family");
  await page.getByRole("button", { name: "Make the invitation" }).tap();
  await page.waitForTimeout(900);
  const copy = page.getByRole("button", { name: "Copy invitation" });
  harness.check(
    (await copy.count()) === 1,
    `${stop("trusted-contacts-invitation")}: the invitation can be copied`,
  );
  await audit(page, stop("trusted-contacts-invitation"));
}

/** A paste that is not a packet is refused on the field, in the touch context. */
async function refusedPaste(page, run) {
  const field = page.getByLabel("An invitation", { exact: true });
  await field.fill("this is not an invitation");
  await page.waitForTimeout(450);
  await run.audit(page, run.stop("trusted-contacts-refused"));
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
    if (label === "circle") await invitationStep(page, run);
    if (label === "accept") await refusedPaste(page, run);
    await closeSheet(page);
  }
}
