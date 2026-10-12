/**
 * The terminal's NATS carrier against a fake connection: what it publishes and
 * subscribes to, how it signs in, what closing leaves open, and that a seat's
 * last frame is given time to go out.
 */
import type { ConnectionOptions, NatsConnection } from "@nats-io/nats-core";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/routes.js";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  CLOSE_GRACE_MS,
  connectOptions,
  natsNodeCarriers,
} from "./live-nats.js";

type Listener = (error: Error | null, message: { string(): string }) => void;

/** The parts of a NATS connection a carrier uses, kept in memory. */
class FakeConnection {
  readonly published: { subject: string; text: string }[] = [];
  readonly events: string[] = [];
  readonly #subs = new Map<string, Set<Listener>>();
  closed = false;
  drained = false;
  options: ConnectionOptions = {};

  publish(subject: string, payload: string): void {
    if (this.closed || this.drained) throw new Error("connection closed");
    this.events.push(`publish ${subject}`);
    this.published.push({ subject, text: payload });
    for (const listener of this.#subs.get(subject) ?? [])
      listener(null, { string: () => payload });
  }

  subscribe(subject: string, options: { callback: Listener }) {
    const set = this.#subs.get(subject) ?? new Set<Listener>();
    set.add(options.callback);
    this.#subs.set(subject, set);
    this.events.push(`subscribe ${subject}`);
    return {
      unsubscribe: () => {
        this.events.push(`unsubscribe ${subject}`);
        set.delete(options.callback);
      },
    };
  }

  async flush(): Promise<void> {
    this.events.push("flush");
  }

  async drain(): Promise<void> {
    this.events.push("drain");
    this.drained = true;
    this.closed = true;
  }

  async close(): Promise<void> {
    this.events.push("close");
    this.closed = true;
  }

  /** The server reports an error to every subscription on `subject`. */
  fail(subject: string): void {
    for (const listener of this.#subs.get(subject) ?? [])
      listener(new Error("permissions violation"), { string: () => "nope" });
  }

  listeners(subject: string): number {
    return this.#subs.get(subject)?.size ?? 0;
  }
}

function opened(graceMs = 0) {
  const connection = new FakeConnection();
  const connect = vi.fn(async (options: ConnectionOptions) => {
    connection.options = options;
    const open: NatsConnection = overlapCast(connection);
    return open;
  });
  return { connection, connect, carriers: natsNodeCarriers(connect, graceMs) };
}

const SPEC: CarrierSpec = { kind: "nats", url: "wss://nats.example.test" };
const SUBJECT = "opensesame.live.TOPIC";

describe("connectOptions", () => {
  it("connects to the spec's server, keeping inboxes under the session", () => {
    expect(connectOptions(SPEC, SUBJECT)).toEqual({
      servers: "wss://nats.example.test",
      reconnect: true,
      maxReconnectAttempts: -1,
      inboxPrefix: `${SUBJECT}._INBOX`,
    });
  });

  it("signs in with a user and password, or a token", () => {
    expect(
      connectOptions({ ...SPEC, username: "ada", password: "pw" }, SUBJECT),
    ).toMatchObject({ user: "ada", pass: "pw" });
    expect(connectOptions({ ...SPEC, token: "tok" }, SUBJECT)).toMatchObject({
      token: "tok",
    });
  });

  it("signs in with a user credential when the spec carries both halves", () => {
    // A well-formed user seed and JWT are not needed to build the authenticator.
    const seed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";
    const jwt = "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJVMSJ9.c2ln";
    expect(
      connectOptions({ ...SPEC, jwt, seed }, SUBJECT).authenticator,
    ).toBeTypeOf("function");
    expect(
      connectOptions({ ...SPEC, jwt }, SUBJECT).authenticator,
    ).toBeUndefined();
    expect(
      connectOptions({ ...SPEC, seed }, SUBJECT).authenticator,
    ).toBeUndefined();
  });
});

describe("natsNodeCarriers", () => {
  it("opens a connection for NATS, on a subject under the topic", async () => {
    const { connect, carriers } = opened();
    const carrier = await carriers(SPEC, "TOPIC", "joiner");
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      servers: SPEC.url,
      inboxPrefix: `${SUBJECT}._INBOX`,
    });
    expect(carrier.channel).toBeTypeOf("function");
  });

  it.each(["nostr", "mqtt", "ntfy", "broadcast"] as const)(
    "rejects a %s carrier without opening anything",
    async (kind) => {
      const { connect, carriers } = opened();
      await expect(
        carriers({ kind, url: "wss://x.test" }, "TOPIC"),
      ).rejects.toThrow(Error);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("rejects when the server cannot be reached", async () => {
    const carriers = natsNodeCarriers(async () => {
      throw new Error("refused");
    }, 0);
    await expect(carriers(SPEC, "TOPIC")).rejects.toThrow("refused");
  });

  it("publishes and flushes on post, and hears on listen", async () => {
    const { connection, carriers } = opened();
    const carrier = await carriers(SPEC, "TOPIC");
    const heard: string[] = [];
    carrier.listen((text) => heard.push(text));
    await carrier.post("osl1.frame");
    expect(connection.published).toEqual([
      { subject: SUBJECT, text: "osl1.frame" },
    ]);
    expect(connection.events.slice(-2)).toEqual([
      `publish ${SUBJECT}`,
      "flush",
    ]);
    expect(heard).toEqual(["osl1.frame"]);
  });

  it("does not report a subscription error as a frame", async () => {
    const { connection, carriers } = opened();
    const carrier = await carriers(SPEC, "TOPIC");
    const heard: string[] = [];
    carrier.listen((text) => heard.push(text));
    connection.fail(SUBJECT);
    expect(heard).toEqual([]);
  });

  it("keeps a seat's subject apart, on the same connection", async () => {
    const { connection, connect, carriers } = opened();
    const carrier = await carriers(SPEC, "TOPIC");
    const seat = carrier.channel?.("seat.abc");
    if (!seat) throw new Error("no channel");
    const onRoot: string[] = [];
    const onSeat: string[] = [];
    carrier.listen((text) => onRoot.push(text));
    seat.listen((text) => onSeat.push(text));
    await seat.post("sealed");
    await carrier.post("code");
    expect(onSeat).toEqual(["sealed"]);
    expect(onRoot).toEqual(["code"]);
    expect(connection.published.map((entry) => entry.subject)).toEqual([
      `${SUBJECT}.seat.abc`,
      SUBJECT,
    ]);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("closing a seat's channel unsubscribes it and leaves the connection open", async () => {
    const { connection, carriers } = opened();
    const carrier = await carriers(SPEC, "TOPIC");
    const seat = carrier.channel?.("seat.abc");
    if (!seat) throw new Error("no channel");
    seat.listen(() => undefined);
    seat.close();
    await carriers.settled();
    expect(connection.listeners(`${SUBJECT}.seat.abc`)).toBe(0);
    expect(connection.closed).toBe(false);
    await carrier.post("still open");
    expect(connection.published).toHaveLength(1);
  });

  it("closing the carrier unsubscribes, then drains and closes once", async () => {
    const { connection, carriers } = opened();
    const carrier = await carriers(SPEC, "TOPIC");
    carrier.listen(() => undefined);
    carrier.close();
    carrier.close();
    expect(connection.listeners(SUBJECT)).toBe(0);
    await carriers.settled();
    expect(connection.events.filter((event) => event === "drain")).toHaveLength(
      1,
    );
    expect(connection.closed).toBe(true);
  });

  it("holds the connection for a frame still being sealed when the carrier closes", async () => {
    vi.useFakeTimers();
    try {
      const { connection, carriers } = opened(CLOSE_GRACE_MS);
      const carrier = await carriers(SPEC, "TOPIC");
      const seat = carrier.channel?.("seat.abc");
      if (!seat) throw new Error("no channel");
      carrier.close();
      expect(connection.closed).toBe(false);
      // The seat's goodbye, sealed a moment after the rendezvous closed.
      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS - 1);
      await seat.post("goodbye");
      expect(connection.published.map((entry) => entry.text)).toEqual([
        "goodbye",
      ]);
      const settled = carriers.settled();
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(connection.events.slice(-2)).toEqual(["flush", "drain"]);
      expect(connection.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to close when draining fails", async () => {
    const { connection, carriers } = opened();
    connection.drain = async () => {
      throw new Error("drain failed");
    };
    const carrier = await carriers(SPEC, "TOPIC");
    carrier.close();
    await carriers.settled();
    expect(connection.events).toContain("close");
  });

  it("has nothing to wait for before anything is closed", async () => {
    const { carriers } = opened();
    await expect(carriers.settled()).resolves.toBeUndefined();
  });
});
