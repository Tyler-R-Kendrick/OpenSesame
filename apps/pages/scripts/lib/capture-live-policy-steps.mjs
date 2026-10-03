/**
 * Capture verbs for a live session's network policy (ADR 0150 §7): a relay
 * the journey answers for, and the operator's own change of policy.
 *
 * A screen may name `relays`: addresses of Nostr/MQTT/NATS servers a real
 * deployment would run. The browser opens a real WebSocket to each and the
 * harness accepts it, so a carrier reads "Carrying codes" as it would against
 * a live relay. Nothing of the app is replaced: the carrier, the status mark
 * and the plan are the build's own. A WebSocket route is installed as an init
 * script, so it has to exist before the page loads: `prepareScreen` does it,
 * beside the screen's `runtimeConfig` (`capture-tab-step.mjs`).
 *
 * `livePurpose` is the operator choosing a purpose card under Settings ›
 * Capabilities › Instance policy, which writes `capabilities.policy.local.v1`
 * and asks the composition store to re-plan, exactly as the card does.
 */

export function livePolicySteps({ press, openSettings }) {
  return {
    /** Choose the purpose card `id` as the operator, then say what the plan holds. */
    async livePurpose(page, id) {
      await openSettings(page, "Capabilities");
      const card = page.getByTestId(`purpose-card-${id}`);
      if (!(await card.count()))
        throw new Error(`capture-evidence livePurpose("${id}"): no such card`);
      await card.scrollIntoViewIfNeeded();
      await press(card);
      await page.waitForTimeout(1200);
      console.log(`  livePurpose: chose ${id}`);
    },
  };
}
