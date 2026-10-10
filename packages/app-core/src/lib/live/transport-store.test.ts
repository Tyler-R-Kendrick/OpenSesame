/**
 * The sealed profile's store (ADR 0150 §6): a profile that is there and does
 * not read is refused — never quietly "direct only", which would drop a
 * `relay: true` — and writes settle in the order they were asked for. The
 * vfs is a fake; the store's own logic is what runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VfsError } from "../vfs.js";
import {
  TRANSPORT_PATH,
  TransportRefused,
  editLiveTransport,
  onTransportChange,
  readLiveTransport,
  readTransportText,
  storeSeams,
  writeLiveTransport,
} from "./transport-store.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
  readTransport,
  transportFileText,
} from "./transport.js";

const files = new Map<string, Uint8Array>();
type Control = {
  /** Milliseconds each write takes, by its call number. */
  delays: number[];
  locked: boolean;
  broken: boolean;
  calls: number;
};
const control: Control = { delays: [], locked: false, broken: false, calls: 0 };
const original = { ...storeSeams };

const fake = {
  refresh: async () => undefined,
  read: async (tomb: string) => {
    if (control.locked) throw new VfsError("locked", "locked");
    if (control.broken) throw new VfsError("corrupt", "corrupt");
    const bytes = files.get(`${tomb}/${TRANSPORT_PATH}`);
    if (!bytes) throw new VfsError("not-found", "none");
    return bytes;
  },
  write: async (tomb: string, bytes: Uint8Array) => {
    const delay = control.delays[control.calls++] ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    files.set(`${tomb}/${TRANSPORT_PATH}`, bytes);
  },
};

afterEach(() => {
  Object.assign(storeSeams, original);
});

const put = (text: string) =>
  files.set(`personal/${TRANSPORT_PATH}`, new TextEncoder().encode(text));

beforeEach(() => {
  Object.assign(storeSeams, fake);
  files.clear();
  Object.assign(control, {
    delays: [],
    locked: false,
    broken: false,
    calls: 0,
  });
});

describe("reading the saved profile", () => {
  it("an absent file is direct only", async () => {
    expect(await readLiveTransport("personal")).toEqual(DIRECT_TRANSPORT);
    expect(await readTransportText("personal")).toBe("{}\n");
  });

  it("reads what was sealed", async () => {
    put('{"addresses":["100.64.0.1"]}');
    expect((await readLiveTransport("personal")).addresses).toEqual([
      "100.64.0.1",
    ]);
  });

  it("refuses a file that does not parse, rather than reading it as direct only", async () => {
    put('{"relay": true, "ice": [');
    await expect(readLiveTransport("personal")).rejects.toThrow(
      TransportRefused,
    );
    await expect(readLiveTransport("personal")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("refuses a relay-only profile that lost its TURN server", async () => {
    put('{"relay": true}');
    await expect(readLiveTransport("personal")).rejects.toThrow(/TURN/);
  });

  it("refuses an oversized file, and still hands its text to the file viewer", async () => {
    put(`{"addresses":[${'"100.64.0.1",'.repeat(4000)}"100.64.0.2"]}`);
    await expect(readLiveTransport("personal")).rejects.toThrow(/too large/);
    expect((await readTransportText("personal")).length).toBeGreaterThan(
      32_000,
    );
  });

  it("refuses, with a plain sentence, a locked or unreadable vault", async () => {
    control.locked = true;
    await expect(readLiveTransport("personal")).rejects.toThrow(
      "Unlock this vault to read its routes",
    );
    control.locked = false;
    control.broken = true;
    await expect(readLiveTransport("personal")).rejects.toThrow(
      "This vault's routes could not be read",
    );
  });
});

describe("writing it", () => {
  const profile = (address: string) => ({
    ...DIRECT_TRANSPORT,
    addresses: [address],
  });

  it("settles writes in the order they were asked for, whatever each takes", async () => {
    control.delays = [60, 0];
    const heard: string[] = [];
    const stop = onTransportChange(() => heard.push("changed"));
    await Promise.all([
      writeLiveTransport("personal", profile("100.64.0.1")),
      writeLiveTransport("personal", profile("100.64.0.2")),
    ]);
    stop();
    // The slow first write does not land last and put the older one back.
    expect((await readLiveTransport("personal")).addresses).toEqual([
      "100.64.0.2",
    ]);
    expect(heard).toHaveLength(2);
  });

  it("a write that fails does not stop the next", async () => {
    await expect(
      writeLiveTransport("personal", {
        ...DIRECT_TRANSPORT,
        relay: true,
      }),
    ).rejects.toThrow(/TURN/);
    await writeLiveTransport("personal", profile("100.64.0.3"));
    expect((await readLiveTransport("personal")).addresses).toEqual([
      "100.64.0.3",
    ]);
  });
});

describe("editing it", () => {
  /** An edit's outcome, checked as the Form checks one. */
  const as = (next: LiveTransport) =>
    readTransport(JSON.parse(transportFileText(next)));

  it("applies the edit to what a write asked for earlier left, in turn", async () => {
    control.delays = [60, 0];
    const first = writeLiveTransport("personal", {
      ...DIRECT_TRANSPORT,
      addresses: ["100.64.0.1"],
    });
    const edited = editLiveTransport("personal", (now) =>
      as({ ...now, addresses: [...now.addresses, "100.64.0.2"] }),
    );
    await Promise.all([first, edited]);
    expect((await readLiveTransport("personal")).addresses).toEqual([
      "100.64.0.1",
      "100.64.0.2",
    ]);
  });

  it("writes nothing for a refused edit, and says why", async () => {
    put('{"addresses":["100.64.0.1"]}');
    const heard: string[] = [];
    const stop = onTransportChange(() => heard.push("changed"));
    const outcome = await editLiveTransport("personal", (now) =>
      as({ ...now, relay: true }),
    );
    stop();
    expect(outcome.ok).toBe(false);
    expect(heard).toEqual([]);
    expect(control.calls).toBe(0);
  });

  it("refuses to edit a profile it cannot read", async () => {
    put("{nope");
    await expect(
      editLiveTransport("personal", (now) => as(now)),
    ).rejects.toThrow(TransportRefused);
    expect(control.calls).toBe(0);
  });
});
