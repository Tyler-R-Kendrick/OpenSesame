/**
 * AT-STATIC-EMPTY: the empty origin's Transport panel, and the Tab walk over
 * its form. Shared state (harness, measurements, external-request log) comes
 * from `verify-transport.mjs`, which keeps the checks it owns.
 */
import { expect } from "@playwright/test";
import {
  NO_SUCH_CLAIM,
  guest,
  openTransport,
  tabTo,
  verifyKey,
} from "./transport-journey.mjs";

/** The form's fields, in the order Tab must reach them. */
export const FORM_FIELDS = [
  "transport-target",
  "transport-policy",
  "transport-execution",
  "transport-identity",
  "transport-trust",
  "transport-profile",
];

/** Tab reaches every form field, each after the one before it; Shift+Tab walks back. */
export async function tabThroughForm(page, label, check) {
  let previous = null;
  for (const id of FORM_FIELDS) {
    const field = page.locator(`#${id}`);
    await tabTo(page, field);
    await expect(field).toBeFocused();
    if (previous) {
      const after = await field.evaluate(
        (node, prior) =>
          Boolean(
            document.querySelector(`#${prior}`)?.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        previous,
      );
      check(after, `${label}: ${id} follows ${previous} in Tab order`);
    }
    previous = id;
  }
  await tabTo(page, page.locator("#transport-trust"), "Shift+Tab");
  check(true, `${label}: Tab reaches every field in order; Shift+Tab returns`);
}

/** The empty-origin journey, bound to the verifier's harness. */
export function createEmptyJourney({
  harness,
  origin,
  base,
  externalDuring,
  measured,
}) {
  const { check, setStep, snap } = harness;

  /**
   * AT-STATIC-EMPTY and the keyboard, at one width with a mouse. With no
   * endpoint the panel is configuration only: a row or key that reports on an
   * endpoint nobody set would do nothing, so none is drawn (ADR 0150).
   */
  async function emptyJourney(browser, width) {
    const step = `empty-${width}`;
    const { page, context } = await harness.newPage(browser, {
      device: { viewport: { width, height: 900 } },
    });
    setStep(step);
    await guest(page, origin, base);
    await openTransport(page);
    const text = await snap(page, step, { fullPage: false });
    check(/Transport/.test(text), `${width}: Transport panel is on Security`);
    for (const id of FORM_FIELDS) {
      check(
        (await page.locator(`#${id}`).count()) === 1,
        `${width}: the form draws ${id}`,
      );
    }
    check(
      (await page.locator("#transport [data-dimension]").count()) === 0,
      `${width}: no status row without an endpoint`,
    );
    check(
      (await page.locator("#transport .status-mark").count()) === 0,
      `${width}: no status glyph without an endpoint`,
    );
    check(
      (await page
        .getByRole("button", { name: "Refresh transport status" })
        .count()) === 0,
      `${width}: no refresh key without an endpoint`,
    );
    check(
      (await (await verifyKey(page)).count()) === 0,
      `${width}: no verification key without an endpoint`,
    );
    check(
      (await page
        .locator("#transport [role=alert], #transport .note")
        .count()) === 0,
      `${width}: no error box`,
    );
    check(!NO_SUCH_CLAIM.test(text), `${width}: no false claim on screen`);
    check(
      !/Not checked/.test(text),
      `${width}: nothing claims a status it never read`,
    );
    check(
      externalDuring(step).length === 0,
      `${width}: zero requests to any other origin`,
    );
    const m = await measured(page, step);
    check(m.rows.length === 0, `${width}: no status rows measured`);
    check(m.refresh === null, `${width}: no refresh key measured`);

    // By id: Security has other panels with an "Identity" field of their own.
    await tabThroughForm(page, `${width}`, check);
    await context.close();
  }

  return emptyJourney;
}
