/**
 * What the walks do about the addresses a live session names (ADR 0150 §6,
 * amended 2026-10-24): the owner names this machine in Routes where the two
 * browsers share one, and the joiner answers the reply's addresses.
 */

/**
 * This machine as a route (ADR 0150 §6, amended 2026-10-24). A walk's two
 * browsers share one machine, and a received description keeps a loopback
 * candidate only when Routes name it: off by default, so a walk names it.
 */
export const SAME_MACHINE = "127.0.0.1";

export async function namesSameMachine(routes) {
  if ((await routes.getByText(SAME_MACHINE, { exact: true }).count()) > 0)
    return;
  await routes.getByLabel("Tailnet, VPN or LAN address").fill(SAME_MACHINE);
  await routes.getByRole("button", { name: "Add the address" }).click();
  await routes.getByText(SAME_MACHINE, { exact: true }).waitFor();
}

/** Where the join stands once the reply was taken, past its addresses. */
const PAST_ADDRESSES =
  /^(Connecting to the owner's browser|Joined |No route to the owner's browser|Connection timed out|The session ended)/;

/**
 * The owner's reply names addresses (ADR 0150 §6): the joiner allows them
 * (`allow`), or joins without them. True when the step was there to answer;
 * false when the reply named none and the join went straight on.
 */
export async function answerAddresses(page, allow = true, timeout = 45_000) {
  const step = page.locator("#live-addresses");
  const past = page.getByRole("img", { name: PAST_ADDRESSES });
  await step.or(past).first().waitFor({ timeout });
  if (!(await step.isVisible())) return false;
  const key = allow ? "Allow the owner's addresses" : "Join without them";
  await step.getByRole("button", { name: key, exact: true }).click();
  return true;
}

/**
 * The owner lets the joiner in (`admit`, its admit control) and the joiner
 * answers the reply's addresses: one step, so a walk that admits over a
 * carrier cannot forget the second. A relay seat's reply names none, and
 * the answer is then nothing to do.
 */
export async function admitAndAnswer(
  admit,
  page,
  allow = true,
  timeout = 45_000,
) {
  await admit.waitFor({ timeout: 30_000 });
  await admit.click();
  return answerAddresses(page, allow, timeout);
}
