/**
 * The cast of `verify-trusted-contacts.mjs` and what they do together: five
 * people (the owner, three guardians and a recipient) on one controlled clock,
 * and the circle they arm — invitation, answers, rule, clocks, packets and
 * receipts — by copying packets from one page and pasting them into the next.
 */

import fs from "node:fs";
import { expect } from "./tc-expect.mjs";
import { acceptInvitation, takeWelcome } from "./tc-guardian.mjs";
import {
  addContact,
  addReceipt,
  copyPacketFor,
  createItem,
  makeCircle,
  nameCircle,
  openNewCircle,
  saveRecoveryFile,
  setClocks,
  setRule,
} from "./tc-owner.mjs";
import { createPerson } from "./tc-people.mjs";

export const ITEM = { name: "Bank login", secret: "correct horse battery" };
const HOUR = 3600 * 1000;

export class Cast {
  constructor({ harness, browser, width, shot, out }) {
    Object.assign(this, { harness, browser, width, shot, out });
    this.offset = 0;
    this.everyone = [];
  }

  /** The clock every page shares: real time, plus whatever the gate has let pass. */
  now() {
    return Date.now() + this.offset;
  }

  /** Let time pass on every person's clock at once; no timer fires. */
  async advance(hours) {
    this.offset += hours * HOUR;
    for (const person of this.everyone) await person.setClock(this.now());
  }

  /** A person with a key that does (or does not) do PRF, entered and on the tab. */
  async person(name, { prf = true } = {}) {
    const { harness, browser, width, shot } = this;
    const who = await createPerson(harness, browser, name, {
      width,
      clock: this.now(),
      shot,
      prf,
    });
    this.everyone.push(who);
    await who.enter();
    return who;
  }

  /** Where everyone stood when a scenario failed: a picture and the text of each page. */
  async photographFailure(step) {
    for (const who of this.everyone) {
      const file = `${this.out}/failed-${step}-${who.name}`;
      await who.page.screenshot({ path: `${file}.png` }).catch(() => {});
      const text = await who.page
        .evaluate(() => document.body.innerText)
        .catch(() => "");
      fs.writeFileSync(`${file}.txt`, text);
    }
  }

  async close() {
    await Promise.all(this.everyone.map((who) => who.close().catch(() => {})));
  }
}

/** Five people in parallel, the owner with one secret in the vault to protect. */
export async function gather(options) {
  const cast = new Cast(options);
  const names = ["Owner", "Ada", "Bo", "Cy", "Recipient"];
  const [owner, ada, bo, cy, recipient] = await Promise.all(
    names.map((name) => cast.person(name)),
  );
  Object.assign(cast, { owner, ada, bo, cy, recipient });
  await createItem(owner, ITEM);
  await owner.openTab();
  return cast;
}

/**
 * The owner's whole ceremony for a circle that holds shares: invite, each
 * guardian answers, the people are added, the rule and the clocks are set, the
 * circle is made, the recovery file saved, every packet taken and every receipt
 * in. Leaves the sheet open on its packets, armed.
 */
export async function armCircle(cast, { name, guardians, needed, hours }) {
  const { owner } = cast;
  const sheet = await openNewCircle(owner);
  const invite = await nameCircle(owner, sheet, name);
  await owner.snap(`${name}-invitation`);
  const enrollments = new Map();
  for (const guardian of guardians) {
    enrollments.set(
      guardian.name,
      await acceptInvitation(guardian, invite, guardian.name),
    );
  }
  for (const guardian of guardians) {
    const enrollment = enrollments.get(guardian.name);
    await addContact(owner, sheet, { enrollment, name: guardian.name });
  }
  await owner.snap(`${name}-people`);
  await setRule(owner, sheet, { needed });
  await owner.snap(`${name}-rule`);
  const form = await setClocks(owner, sheet, { minutes: 10, hours, days: 7 });
  await owner.snap(`${name}-clocks`);
  await makeCircle(owner, sheet, form);
  await owner.snap(`${name}-packets`);
  const file = await saveRecoveryFile(owner, sheet, `${cast.out}/${name}.json`);
  const packets = new Map();
  for (const guardian of guardians) {
    packets.set(
      guardian.name,
      await copyPacketFor(owner, sheet, guardian.name),
    );
  }
  await handOut(cast, { name, sheet, guardians, packets });
  await expect(sheet.getByText("Armed", { exact: true })).toBeVisible();
  await owner.snap(`${name}-armed`);
  return { sheet, file, invite, enrollments, packets };
}

/** Each guardian takes their packet (two touches) and the receipt goes back to the owner. */
async function handOut(cast, { name, sheet, guardians, packets }) {
  for (const guardian of guardians) {
    const receipt = await takeWelcome(guardian, packets.get(guardian.name), {
      circle: name,
    });
    await addReceipt(cast.owner, sheet, { receipt, name: guardian.name });
  }
}
