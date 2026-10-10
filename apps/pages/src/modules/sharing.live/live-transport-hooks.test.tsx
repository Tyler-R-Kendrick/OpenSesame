/** @vitest-environment jsdom */
/**
 * Edits to the owner's transport profile, in real time (ADR 0150 §6): the
 * hook and the real transport store run; only the vfs under the store is a
 * fake, whose writes take as long as the test says. Every scenario here lost
 * an edit, or read a broken profile as "direct only", before the hook applied
 * each edit to the profile as it is when its turn comes.
 */
import {
  TRANSPORT_PATH,
  storeSeams,
  writeLiveTransport,
} from "@opensesame/app-core/lib/live/transport-store.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
} from "@opensesame/app-core/lib/live/transport.js";
import { VfsError } from "@opensesame/app-core/lib/vfs.js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAddress, withCarrier } from "./live-transport-edits.js";
import { transportSeams, useLiveTransport } from "./live-transport-hooks.js";

const files = new Map<string, Uint8Array>();
type Control = {
  /** How long each write takes, by its call number (ms). */
  delays: number[];
  /** The call numbers whose write throws. */
  failing: Set<number>;
  locked: boolean;
  calls: number;
  /** How long each read takes, by its call number (ms). */
  readDelays: number[];
  reads: number;
};
const control: Control = {
  delays: [],
  failing: new Set(),
  locked: false,
  calls: 0,
  readDelays: [],
  reads: 0,
};

/** The vfs under the real store: a memory whose writes take as long as told. */
const memory = {
  refresh: async () => undefined,
  read: async (tomb: string) => {
    if (control.locked) throw new VfsError("locked", "locked");
    // A sealed read opens what it found when it began, however long it takes.
    const bytes = files.get(`${tomb}/${TRANSPORT_PATH}`);
    await new Promise((resolve) =>
      setTimeout(resolve, control.readDelays[control.reads++] ?? 0),
    );
    if (!bytes) throw new VfsError("not-found", "none");
    return bytes;
  },
  write: async (tomb: string, bytes: Uint8Array) => {
    const call = control.calls++;
    await new Promise((resolve) =>
      setTimeout(resolve, control.delays[call] ?? 0),
    );
    if (control.failing.has(call)) throw new Error("disk full");
    files.set(`${tomb}/${TRANSPORT_PATH}`, bytes);
  },
};

const original = { ...transportSeams };
const originalStore = { ...storeSeams };
const sealed = (): LiveTransport => {
  const bytes = files.get(`personal/${TRANSPORT_PATH}`);
  const file = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  return { ...DIRECT_TRANSPORT, ...file };
};
const put = (text: string) =>
  files.set(`personal/${TRANSPORT_PATH}`, new TextEncoder().encode(text));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  files.clear();
  Object.assign(control, {
    delays: [],
    failing: new Set<number>(),
    locked: false,
    calls: 0,
    readDelays: [],
    reads: 0,
  });
  Object.assign(transportSeams, { tomb: () => "personal" });
  Object.assign(storeSeams, memory);
});

afterEach(() => {
  cleanup();
  Object.assign(transportSeams, original);
  Object.assign(storeSeams, originalStore);
});

const NOSTR = { kind: "nostr" as const, url: "wss://relay.example.com" };

async function ready() {
  const view = renderHook(() => useLiveTransport());
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  return view;
}

describe("edits made while an earlier write is still being sealed", () => {
  it("keep every edit: address, then a carrier mid-write, then another address after the first lands", async () => {
    control.delays = [60, 60, 60];
    const { result } = await ready();
    const outcomes: (string | null)[] = [];
    const change = result.current.change;
    // t=0: address .1 (a 60 ms write). t=30: a carrier. t=70: address .2 —
    // after write 1 landed and its reload came back, while write 2 is out.
    void change((now) => withAddress(now, "100.64.0.1")).then((o) =>
      outcomes.push(o),
    );
    await sleep(30);
    void change((now) => withCarrier(now, NOSTR)).then((o) => outcomes.push(o));
    // The screen answers at once, on top of the pending edit.
    await waitFor(() => {
      expect(result.current.transport.addresses).toEqual(["100.64.0.1"]);
      expect(result.current.transport.carriers).toEqual([NOSTR]);
    });
    await sleep(40);
    void change((now) => withAddress(now, "100.64.0.2")).then((o) =>
      outcomes.push(o),
    );
    await waitFor(() => expect(outcomes).toHaveLength(3), { timeout: 2000 });

    expect(outcomes).toEqual([null, null, null]);
    expect(sealed()).toEqual({
      ...DIRECT_TRANSPORT,
      addresses: ["100.64.0.1", "100.64.0.2"],
      carriers: [NOSTR],
    });
    await waitFor(() => expect(result.current.transport).toEqual(sealed()));
  });

  it("do not lose the later one when the earlier write is the slower", async () => {
    control.delays = [80, 0];
    const { result } = await ready();
    const first = result.current.change((now) =>
      withAddress(now, "100.64.0.1"),
    );
    const second = result.current.change((now) => withCarrier(now, NOSTR));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(sealed().addresses).toEqual(["100.64.0.1"]);
    expect(sealed().carriers).toEqual([NOSTR]);
  });

  it("a write that fails is undone, the ones after it are not, and the last kept profile stays", async () => {
    // Call 1 (the second edit's write) fails.
    control.failing = new Set([1]);
    const { result } = await ready();
    const one = result.current.change((now) => withAddress(now, "100.64.0.1"));
    const two = result.current.change((now) => withAddress(now, "100.64.0.2"));
    const three = result.current.change((now) => withCarrier(now, NOSTR));
    expect(await Promise.all([one, two, three])).toEqual([
      null,
      "This vault could not keep the change",
      null,
    ]);
    expect(sealed().addresses).toEqual(["100.64.0.1"]);
    expect(sealed().carriers).toEqual([NOSTR]);
    await waitFor(() => expect(result.current.transport).toEqual(sealed()));
  });

  it("an edit the profile refuses changes nothing and says why", async () => {
    const { result } = await ready();
    const refused = await result.current.change((now) => ({
      ...now,
      relay: true,
    }));
    expect(refused).toMatch(/TURN/);
    expect(files.size).toBe(0);
    expect(result.current.transport.relay).toBe(false);
  });

  it("an edit the page is closed on still lands, and sets nothing on a dead screen", async () => {
    control.delays = [40];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { result, unmount } = await ready();
    const written = result.current.change((now) =>
      withAddress(now, "100.64.0.9"),
    );
    unmount();
    expect(await written).toBeNull();
    expect(sealed().addresses).toEqual(["100.64.0.9"]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("a saved profile that cannot be used", () => {
  it("is refused, not read as direct only", async () => {
    put('{"relay": true, "ice": [');
    const { result } = await ready();
    expect(result.current.refused).toMatch(/not valid JSON/);
    expect(result.current.transport).toEqual(DIRECT_TRANSPORT);
  });

  it("clears once the file is fixed, from the file viewer or anywhere", async () => {
    put("{nope");
    const { result } = await ready();
    expect(result.current.refused).not.toBeNull();
    await act(async () => {
      await writeLiveTransport("personal", {
        ...DIRECT_TRANSPORT,
        addresses: ["100.64.0.1"],
      });
    });
    await waitFor(() => expect(result.current.refused).toBeNull());
    expect(result.current.transport.addresses).toEqual(["100.64.0.1"]);
  });

  it("a locked vault is a plain refusal, and the panel is not left reading", async () => {
    control.locked = true;
    const { result } = await ready();
    expect(result.current.loaded).toBe(true);
    expect(result.current.refused).toBe("Unlock this vault to read its routes");
  });

  it("a read that throws anything else is a refusal too", async () => {
    Object.assign(transportSeams, {
      read: async () => {
        throw new Error("boom");
      },
    });
    const { result } = await ready();
    expect(result.current.refused).toBe(
      "This vault's routes could not be read",
    );
  });
});

describe("a write from elsewhere", () => {
  it("is never put back by an edit that read the profile before it landed", async () => {
    const { result } = await ready();
    // The edit's read (the second) is slow; the file viewer saves meanwhile.
    control.readDelays = [0, 80];
    let edited: Promise<string | null> = Promise.resolve(null);
    act(() => {
      edited = result.current.change((now) => withAddress(now, "100.64.0.9"));
    });
    await sleep(20);
    const saved = writeLiveTransport("personal", {
      ...DIRECT_TRANSPORT,
      carriers: [NOSTR],
    });
    await act(async () => {
      await Promise.all([edited, saved]);
    });
    expect(sealed().carriers).toEqual([NOSTR]);
    await waitFor(() =>
      expect(result.current.transport.carriers).toEqual([NOSTR]),
    );
  });

  it("the file viewer's write reaches the screen", async () => {
    const { result } = await ready();
    await act(async () => {
      await writeLiveTransport("personal", {
        ...DIRECT_TRANSPORT,
        carriers: [NOSTR],
      });
    });
    await waitFor(() =>
      expect(result.current.transport.carriers).toEqual([NOSTR]),
    );
  });
});
