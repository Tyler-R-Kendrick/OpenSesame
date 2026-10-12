/**
 * The terminal's NATS carrier with the real `@nats-io/nats-core` client over a
 * real WebSocket (Node's global one), against `MiniNats`, a small in-process
 * server that speaks the client protocol. It is not nats-server —
 * authorization, permissions and clustering are not in it — so what this
 * proves is the client side: that the options we hand the official client
 * connect, authenticate as the spec says, route a subject and a seat's subject
 * apart, and let a closing seat's last frame out.
 */
import type { CarrierSpec } from "@opensesame/app-core/lib/live/routes.js";
import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { natsNodeCarriers } from "./live-nats.js";
import { MiniNats } from "./mini-nats.test-support.js";

const SUBJECT = "opensesame.live.TOPIC";

const servers: MiniNats[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function serve(info: JsonObject = {}): Promise<MiniNats> {
  const server = await MiniNats.start(info);
  servers.push(server);
  return server;
}

function until(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - started > 4000)
        return reject(new Error("never happened"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("the carrier over a real WebSocket", () => {
  it("passes a frame between two connections, and keeps a seat's subject apart", async () => {
    const server = await serve();
    const spec: CarrierSpec = { kind: "nats", url: server.url };
    const carriers = natsNodeCarriers(undefined, 0);
    const [a, b] = await Promise.all([
      carriers(spec, "TOPIC", "joiner"),
      carriers(spec, "TOPIC", "joiner"),
    ]);
    const onRoot: string[] = [];
    const onSeat: string[] = [];
    b.listen((text) => onRoot.push(text));
    b.channel?.("seat.one").listen((text) => onSeat.push(text));
    // A subscription is sent with the next write, not flushed: give it time.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await a.post("a code, in frames");
    await a.channel?.("seat.one").post("sealed frame");
    await until(() => onRoot.length > 0 && onSeat.length > 0);
    expect(onRoot).toEqual(["a code, in frames"]);
    expect(onSeat).toEqual(["sealed frame"]);
    expect(server.published.map((entry) => entry.subject)).toEqual([
      SUBJECT,
      `${SUBJECT}.seat.one`,
    ]);
    a.close();
    b.close();
    await carriers.settled();
  });

  it("signs in with a user and password, or a token", async () => {
    const server = await serve({ auth_required: true });
    const carriers = natsNodeCarriers(undefined, 0);
    const base: CarrierSpec = { kind: "nats", url: server.url };
    const withUser = await carriers(
      { ...base, username: "ada", password: "pw" },
      "TOPIC",
    );
    const withToken = await carriers({ ...base, token: "tok" }, "TOPIC");
    expect(server.connects[0]).toMatchObject({ user: "ada", pass: "pw" });
    expect(server.connects[1]).toMatchObject({ auth_token: "tok" });
    withUser.close();
    withToken.close();
    await carriers.settled();
  });

  it("signs in with a user credential, signing the server's nonce", async () => {
    const server = await serve({ auth_required: true, nonce: "n0nce" });
    const carriers = natsNodeCarriers(undefined, 0);
    const jwt = "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJVMSJ9.c2ln";
    const seed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";
    const carrier = await carriers(
      { kind: "nats", url: server.url, jwt, seed },
      "TOPIC",
    );
    expect(server.connects[0]).toMatchObject({ jwt, sig: expect.any(String) });
    expect(server.connects[0]?.sig).not.toBe("");
    carrier.close();
    await carriers.settled();
  });

  it("lets a seat's last frame out after the carrier closes, then closes", async () => {
    const server = await serve();
    const carriers = natsNodeCarriers();
    const carrier = await carriers({ kind: "nats", url: server.url }, "TOPIC");
    const seat = carrier.channel?.("seat.one");
    if (!seat) throw new Error("no channel");
    carrier.close();
    // The rendezvous has closed the carrier; the seat is still sealing its goodbye.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await seat.post("end");
    await carriers.settled();
    expect(server.published).toEqual([
      { subject: `${SUBJECT}.seat.one`, text: "end" },
    ]);
    await server.closed;
  });

  it("rejects when nothing is listening, so the rendezvous marks it failed", async () => {
    const server = await serve();
    const { url } = server;
    await server.stop();
    const carriers = natsNodeCarriers(undefined, 0);
    await expect(carriers({ kind: "nats", url }, "TOPIC")).rejects.toThrow();
  });
});
