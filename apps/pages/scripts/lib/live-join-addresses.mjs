/**
 * What the walks do about the addresses a live session names (ADR 0150 §6,
 * amended 2026-10-24): the owner names this machine in Routes where the two
 * browsers share one, and the joiner answers the reply's addresses.
 */

import { expect } from "@playwright/test";
import { defaultRouteAddress } from "./live-engines.mjs";
import { joinedMarks } from "./live-joined.mjs";

/**
 * This machine as a route (ADR 0150 §6, amended 2026-10-24). A walk's two
 * browsers share one machine, and a received description keeps a loopback
 * candidate only when Routes name it: off by default, so a walk names it.
 */
export const SAME_MACHINE = "127.0.0.1";

/**
 * This machine, for two browsers that show their host addresses in the clear
 * (`live-engines.mjs`): its loopback, and its default-route address, the one
 * interface every engine gathers on. Loopback alone reaches only a browser
 * whose ICE socket is bound to every interface, so a hint at 127.0.0.1 lands
 * on it (Chromium). Firefox gathers its default-route address alone, on a
 * socket bound to that address, so its hint at 127.0.0.1 names a port no
 * socket of its holds, and it does not pair its candidate with a peer's
 * loopback one: with loopback alone a pair with Firefox in it fails ICE. Its
 * candidate at the machine's private address is what it can meet over, and
 * the session drops that one unless Routes name it.
 */
export async function thisMachine() {
  return [SAME_MACHINE, await defaultRouteAddress()];
}

/**
 * Name this machine in Routes through the Form: loopback (`true`), or the
 * `addresses` given (`thisMachine`), each once.
 */
export async function namesSameMachine(routes, addresses = true) {
  const field = routes.getByLabel("Tailnet, VPN or LAN address");
  for (const address of addresses === true ? [SAME_MACHINE] : addresses) {
    if ((await routes.getByText(address, { exact: true }).count()) > 0)
      continue;
    await field.fill(address);
    const add = routes.getByRole("button", { name: "Add the address" });
    await expect(add).toBeEnabled();
    await add.click();
    await routes.getByText(address, { exact: true }).waitFor();
    // The Form empties the field once the address is kept: the next one is
    // typed into an empty field, as a person types it.
    await expect(field).toHaveValue("");
  }
}

/** Where the join stands once the reply was taken and it has not joined. */
const NOT_JOINED =
  /^(Connecting to the owner's browser|No route to the owner's browser|Connection timed out|The session ended)/;

/**
 * The owner's reply names addresses (ADR 0150 §6): the joiner allows them
 * (`allow`), or joins without them. True when the step was there to answer;
 * false when the reply named none and the join went straight on, however
 * far: a join that completes first has already opened the joiner's vault,
 * so being past the step is read through the walks' one "joined"
 * (`joinedMarks`) as well as the statuses short of it.
 */
export async function answerAddresses(page, allow = true, timeout = 45_000) {
  const step = page.locator("#live-addresses");
  const past = page
    .getByRole("img", { name: NOT_JOINED })
    .or(joinedMarks(page));
  await step.or(past).first().waitFor({ state: "attached", timeout });
  if ((await step.count()) === 0) return false;
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
