/**
 * Letting a guest into a live session records ids only (PF-24).
 */
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { activitySeams, listActivityEvents } from "../activity-log.js";
import { listReceipts } from "../device-receipts.js";
import {
  flushSharingReceipts,
  resetSharingReceiptsForTest,
} from "../sharing-receipts.js";
import { lockAllTombs, unlockTomb } from "../vfs.js";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { FakeNet } from "./live-fakes.js";

const NAME = "GUEST-NAME-LEAK";
const NOTE = "NOTE-LEAK";
const FIELD = "FIELD-SECRET-LEAK";
const previousTomb = activitySeams.activeTomb;
const hosts: LiveHost[] = [];
const guests: LiveGuest[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) host.end();
  for (const guest of guests.splice(0)) guest.leave();
  await flushSharingReceipts();
  resetSharingReceiptsForTest();
  activitySeams.activeTomb = previousTomb;
  lockAllTombs();
});

it("records the session and the request, not the code, the link or the name", async () => {
  const tomb = `live-grant-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  activitySeams.activeTomb = () => tomb;
  const net = new FakeNet();
  const host = await LiveHost.start({
    admission: "invite",
    expiresAt: Date.now() + 60_000,
    catalog: () => ({
      title: "Team",
      policy: "read",
      expiresAt: Date.now() + 60_000,
      items: [],
    }),
    readField: async () => FIELD,
    transport: net.transport(),
  });
  hosts.push(host);
  const code = host.code ?? "";
  expect(code.length).toBeGreaterThan(0);
  // A string that is not a request is not a grant.
  expect(await host.receive("BCDF-GHJK")).toEqual({ kind: "not-a-request" });
  await flushSharingReceipts();
  expect(JSON.stringify(await listActivityEvents(tomb))).not.toContain(
    "access.live.granted",
  );
  const guest = new LiveGuest({
    link: host.link,
    code,
    name: NAME,
    note: NOTE,
    transport: net.transport(),
  });
  guests.push(guest);
  const received = await host.receive(await guest.start());
  expect(received.kind).toBe("guest");
  if (received.kind !== "guest") return;
  await host.admit(received.key);
  const reply = host.state.guests.find(
    (row) => row.key === received.key,
  )?.reply;

  await flushSharingReceipts();
  const blob = JSON.stringify({
    activity: await listActivityEvents(tomb),
    receipts: await listReceipts(tomb, 20),
  });
  expect(blob).toContain(host.id);
  expect(blob).toContain(received.key);
  expect(blob).toContain("access.live.granted");
  expect(blob).not.toContain(code);
  expect(blob).not.toContain(host.link.secret);
  expect(blob).not.toContain(NAME);
  expect(blob).not.toContain(NOTE);
  expect(blob).not.toContain(FIELD);
  expect(reply).toBeTruthy();
  if (reply) expect(blob).not.toContain(reply);
  expect(blob.match(/access\.live\.granted/gu)).toHaveLength(2);
});
