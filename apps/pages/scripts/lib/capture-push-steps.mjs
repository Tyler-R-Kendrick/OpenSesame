/**
 * Capture verbs for the Push row (`"stack": "push"` journeys, see
 * `capture-harness.mjs`): the facts only the stack knows, and the one state a
 * person cannot reach by pressing keys — an account already at its limit.
 */

import { pushSessions } from "./capture-harness.mjs";

const LIMIT = 10;

export function pushSteps({ harness, press }) {
  const sessionOf = (page) => {
    const session = pushSessions.get(page);
    if (!session?.principal)
      throw new Error(
        "capture-evidence: this page was given no Identity session yet — a push verb needs the stack and a page that has booted",
      );
    return session;
  };

  return {
    /** Let an enrolment finish: the notice or the mark is the answer, not a timer. */
    async settle(page, ms) {
      await page.waitForTimeout(ms ?? 2500);
    },
    /**
     * Open the notification tray the way a person does: the bell where the
     * statusline has one, else the overflow key and its Notifications row.
     */
    async tray(page) {
      const bell = page.getByRole("button", { name: /^Notifications — / });
      if (await bell.count()) {
        await press(bell.first());
      } else {
        await press(page.getByRole("button", { name: /^More —/ }).first());
        await page.waitForTimeout(650);
        await press(
          page.getByRole("button", { name: /^Notifications/ }).first(),
        );
      }
      await page.waitForTimeout(900);
    },
    /**
     * Fill this principal's subscriptions to the service's limit, the way ten
     * browsers signed in as one person would have: the next key press is the
     * eleventh.
     */
    async pushLimit(page) {
      const { principal } = sessionOf(page);
      for (let i = 0; i < LIMIT; i += 1) {
        const made = await harness.stack.register(
          principal.bearer,
          harness.stack.standIn.mint(),
        );
        if (made.status !== 201)
          throw new Error(`capture-evidence pushLimit: ${made.status}`);
      }
    },
    /** Print what the stack saw, so a sheet's numbers are read, not remembered. */
    async pushFacts(page) {
      const { principal, shim } = sessionOf(page);
      const keys = await page
        .getByRole("button", { name: /push on this device/i })
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
      const rows = await harness.stack.live(principal.id);
      console.log(
        `  push: row key ${JSON.stringify(keys)}; browser subscribed ${shim.subscribed.length}, unsubscribed ${shim.unsubscribed.length}, holds ${shim.held ? "one" : "none"}; Identity API holds ${rows.length}; push-service requests ${harness.stack.standIn.received.length}`,
      );
    },
  };
}
