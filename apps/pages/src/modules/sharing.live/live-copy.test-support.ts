import type { LiveGuest } from "@opensesame/app-core/lib/live/guest.js";
import type {
  ReadField,
  WriteField,
} from "@opensesame/app-core/lib/live/host-peer.js";
import { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { plan } from "@opensesame/app-core/lib/live/live-plan.fixture.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import { DIRECT_ONLY } from "@opensesame/app-core/lib/live/peer.js";
import { joinLive, liveSeams } from "@opensesame/app-core/lib/live/session.js";
import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

export const VALUE = "controlled-live-field-fixture";
export const ITEM = "controlled-account";
type ClipboardMemory = { content: string; writes: string[] };

export function clipboardFixture() {
  const memory: ClipboardMemory = {
    content: "",
    writes: [],
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: async () => memory.content,
      writeText: async (value: string) => {
        memory.writes.push(value);
        memory.content = value;
      },
    },
  });
  return memory;
}

export async function makeRequest(
  policy: SharePolicy = "read",
  read: ReadField = async (item, field) =>
    item === ITEM && field === "password" ? VALUE : null,
  write?: WriteField,
) {
  Object.assign(liveSeams, {
    plan: () => plan(true),
    onPlan: () => () => {},
  });
  const net = new FakeNet();
  const expiresAt = Date.now() + 300_000;
  const owner = await LiveHost.start({
    admission: "invite",
    ice: DIRECT_ONLY,
    expiresAt,
    catalog: () => ({
      title: "Team",
      policy,
      expiresAt,
      items: [
        {
          id: ITEM,
          name: "GitHub",
          type: "account",
          fields: [
            {
              key: "password",
              label: "Password",
              concealed: true,
              value: null,
            },
          ],
        },
      ],
    }),
    readField: read,
    writeField: write,
    peers: net.factory(),
  });
  try {
    const guest = await joinLive({
      link: owner.link,
      code: owner.code,
      name: "Ada Lovelace",
      note: "",
      useRoutes: false,
      peers: net.factory(),
    });
    const status = guest.status;
    if (status.at !== "request") throw new Error("No genuine request.");
    return { owner, guest, code: status.code };
  } catch (error) {
    owner.end("owner");
    throw error;
  }
}

export async function connect(owner: LiveHost, guest: LiveGuest, code: string) {
  const received = await owner.receive(code);
  if (received.kind !== "guest")
    throw new Error("Owner refused valid request.");
  await owner.admit(received.key);
  const reply = owner.state.guests.find(
    (row) => row.key === received.key,
  )?.reply;
  if (!reply) throw new Error("No genuine reply.");
  expect(await guest.accept(reply)).toBe(true);
  await waitFor(() => expect(guest.status.at).toBe("joined"));
  const status = guest.status;
  if (status.at !== "joined") throw new Error("No genuine catalog.");
  return status.catalog;
}
