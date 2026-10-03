/**
 * AT-STATIC-EMPTY: the empty origin's Security page draws no Transport
 * panel. Shared state comes from `verify-transport.mjs`.
 */
import { NO_SUCH_CLAIM, guest, openSecurity } from "./transport-journey.mjs";

const FORM_FIELDS = [
  "transport-target",
  "transport-policy",
  "transport-execution",
  "transport-identity",
  "transport-trust",
  "transport-profile",
];

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
   * AT-STATIC-EMPTY: a guest opens Security. The page draws no Transport
   * panel, no form, and no status, and the tab calls no other origin.
   */
  async function emptyJourney(browser, width) {
    const step = `empty-${width}`;
    const { page, context } = await harness.newPage(browser, {
      device: { viewport: { width, height: 900 } },
    });
    setStep(step);
    await guest(page, origin, base);
    await openSecurity(page);
    const text = await snap(page, step, { fullPage: false });
    check(
      (await page.locator("#transport").count()) === 0,
      `${width}: Security draws no Transport panel`,
    );
    for (const id of FORM_FIELDS) {
      check(
        (await page.locator(`#${id}`).count()) === 0,
        `${width}: no ${id} field`,
      );
    }
    check(
      (await page
        .getByRole("button", { name: "Refresh transport status" })
        .count()) === 0,
      `${width}: no refresh key`,
    );
    check(!NO_SUCH_CLAIM.test(text), `${width}: no false claim on screen`);
    check(
      externalDuring(step).length === 0,
      `${width}: zero requests to any other origin`,
    );
    const m = await measured(page, step);
    check(m.panel === null, `${width}: no transport panel measured`);
    check(m.rows.length === 0, `${width}: no status rows measured`);
    check(m.refresh === null, `${width}: no refresh key measured`);
    check(m.selectFont === null, `${width}: no transport select`);
    await context.close();
  }

  return emptyJourney;
}
