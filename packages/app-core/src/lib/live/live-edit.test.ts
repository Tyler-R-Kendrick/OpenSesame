/** An authorized edit is a channel save the owner's writer records. */
import { afterEach, describe, expect, it } from "vitest";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { FakeNet } from "./live-fakes.js";
import type { Catalog, SharePolicy } from "./messages.js";

const SECRET_VALUE = "correct horse battery staple";

type SavedWrite = Readonly<{
  item: string;
  field: string;
  value: string;
}>;

function catalog(policy: SharePolicy): Catalog {
  return {
    title: "Team vault",
    policy,
    expiresAt: Date.now() + 60_000,
    items: [
      {
        id: "item-1",
        name: "GitHub",
        type: "account",
        fields: [
          {
            key: "username",
            label: "Username",
            concealed: false,
            value: "octo",
          },
          { key: "password", label: "Password", concealed: true, value: null },
        ],
      },
    ],
  };
}

const hosts: LiveHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
});

async function hosted(policy: SharePolicy, writer: boolean) {
  const net = new FakeNet();
  const writes: SavedWrite[] = [];
  const writeField = async (item: string, field: string, value: string) => {
    if (item !== "item-1" || field !== "password") return false;
    writes.push({ item, field, value });
    return true;
  };
  const base = {
    admission: "invite" as const,
    expiresAt: Date.now() + 60_000,
    catalog: () => catalog(policy),
    readField: async (item: string, field: string) =>
      item === "item-1" && field === "password" ? SECRET_VALUE : null,
    transport: net.transport(),
  };
  const host = await LiveHost.start(writer ? { ...base, writeField } : base);
  hosts.push(host);
  return { net, host, writes };
}

function joiner(net: FakeNet, host: LiveHost): LiveGuest {
  return new LiveGuest({
    link: host.link,
    code: host.code,
    name: "Ada",
    note: "from design",
    transport: net.transport(),
  });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 50; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function pair(host: LiveHost, guest: LiveGuest): Promise<void> {
  const request = await guest.start();
  const received = await host.receive(request);
  if (received.kind !== "guest") throw new Error(received.kind);
  await host.admit(received.key);
  const reply = host.state.guests.find(
    (row) => row.key === received.key,
  )?.reply;
  expect(await guest.accept(reply ?? "")).toBe(true);
  await settle();
}

describe("an authorized edit", () => {
  it("records the save and still reveals the current value", async () => {
    const session = await hosted("edit", true);
    const guest = joiner(session.net, session.host);
    await pair(session.host, guest);
    expect(await guest.request("reveal", "item-1", "password")).toBe(
      SECRET_VALUE,
    );
    expect(await guest.edit("item-1", "password", "rotated")).toBe("rotated");
    expect(session.writes).toEqual([
      { item: "item-1", field: "password", value: "rotated" },
    ]);
    expect(session.host.state.log.at(-1)).toMatchObject({
      what: "edit",
      item: "item-1",
      field: "password",
    });
    expect(await guest.edit("payroll", "password", "nope")).toBeNull();
    expect(session.writes).toHaveLength(1);
  });

  it("refuses an edit under read, and when the host has no writer", async () => {
    const reading = await hosted("read", true);
    const reader = joiner(reading.net, reading.host);
    await pair(reading.host, reader);
    expect(await reader.edit("item-1", "password", "rotated")).toBeNull();
    expect(reading.writes).toEqual([]);
    expect(reading.host.state.log.at(-1)?.what).toBe("denied");

    const unwired = await hosted("edit", false);
    const blocked = joiner(unwired.net, unwired.host);
    await pair(unwired.host, blocked);
    expect(await blocked.edit("item-1", "password", "rotated")).toBeNull();
    expect(unwired.host.state.log.at(-1)?.what).toBe("denied");
  });
});
