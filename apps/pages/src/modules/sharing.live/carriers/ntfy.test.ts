/** @vitest-environment node */
/**
 * The ntfy carrier through the module's real `EgressPort` (ADR 0150 §7):
 * every request is checked against the current plan, redirects and
 * credentials are the port's, and the JSON stream still arrives as it is
 * written — the port hands the response back untouched.
 */

import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import { describe, expect, it, vi } from "vitest";
import { CARRIER_PURPOSE } from "./allowed.js";
import { basicCredentials, ntfyCarrier } from "./ntfy.js";
import { ALLOW_ALL, gateFor, gateWith, planUnder, policy } from "./plan-kit.js";

const SPEC: CarrierSpec = { kind: "ntfy", url: "https://ntfy.example.test/" };
const TOPIC = "topic123";
const enc = new TextEncoder();

/** A JSON stream the test writes to as the server would. */
function stream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: () => new Response(body, { status: 200 }),
    write: (line: string) => controller?.enqueue(enc.encode(`${line}\n`)),
    end: () => controller?.close(),
  };
}

const message = (id: string, text: string) =>
  JSON.stringify({ id, event: "message", message: text });

type Call = { url: string; init: RequestInit };

describe("ntfy through the egress port", () => {
  it("reads a stream as it arrives, and posts, both under the declared purpose", async () => {
    const live = stream();
    const calls: Call[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return init?.method === "POST"
        ? new Response(null, { status: 200 })
        : live.response();
    });
    const gate = gateFor(planUnder(policy(ALLOW_ALL)), fetchImpl);
    const spy = vi.spyOn(gate.egress, "fetch");
    const carrier = await ntfyCarrier(
      { ...SPEC, token: "tk_secret" },
      TOPIC,
      gate.egress,
      new AbortController().signal,
    );
    const heard: string[] = [];
    const stop = carrier.listen((text) => heard.push(text));
    // The stream is still open: what was written has already been heard.
    live.write(message("id1", "first"));
    await vi.waitFor(() => expect(heard).toEqual(["first"]));
    live.write("not json");
    live.write(message("id2", "second"));
    await vi.waitFor(() => expect(heard).toEqual(["first", "second"]));
    await carrier.post("frame");
    stop();

    expect(calls.map((c) => c.url)).toEqual([
      `https://ntfy.example.test/${TOPIC}/json`,
      `https://ntfy.example.test/${TOPIC}`,
    ]);
    for (const { init } of calls) {
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer tk_secret",
      );
    }
    expect(calls[1]?.init.body).toBe("frame");
    for (const call of spy.mock.calls)
      expect(call[2]).toEqual({
        capability: "sharing.live",
        purpose: CARRIER_PURPOSE,
      });
    live.end();
  });

  it("refuses at once, opening nothing, when the plan does not allow the origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("x"));
    const gate = gateFor(
      planUnder(
        policy({
          externalServices: "allow",
          allowedServiceOrigins: ["https://ntfy.other.test"],
        }),
      ),
      fetchImpl,
    );
    await expect(
      ntfyCarrier(SPEC, TOPIC, gate.egress, new AbortController().signal),
    ).rejects.toMatchObject({
      name: "EgressDenied",
      code: "origin-not-allowed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops for good, without retrying, when the plan withdraws mid-session", async () => {
    let plan = planUnder(policy(ALLOW_ALL));
    const withdrawn = planUnder(policy(ALLOW_ALL), false);
    const live = stream();
    const fetchImpl = vi.fn<typeof fetch>(async () => live.response());
    const gate = gateWith(() => plan, fetchImpl);
    const carrier = await ntfyCarrier(
      SPEC,
      TOPIC,
      gate.egress,
      new AbortController().signal,
    );
    carrier.listen(() => {});
    plan = withdrawn;
    // The server ends the stream; the loop reconnects — and egress says no.
    live.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(carrier.post("late")).rejects.toMatchObject({
      name: "EgressDenied",
    });
    carrier.close();
  });

  it("abandons the first request when the connect budget runs out", async () => {
    const first: { signal: AbortSignal | null } = { signal: null };
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          first.signal = init?.signal ?? null;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const gate = gateFor(planUnder(policy(ALLOW_ALL)), fetchImpl);
    const connecting = new AbortController();
    const opening = ntfyCarrier(SPEC, TOPIC, gate.egress, connecting.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(first.signal).not.toBeNull();
    expect(first.signal?.aborted).toBe(false);
    connecting.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(first.signal?.aborted).toBe(true);
  });

  it("reports a server that says no", async () => {
    const gate = gateFor(
      planUnder(policy(ALLOW_ALL)),
      async () => new Response("no", { status: 401 }),
    );
    await expect(
      ntfyCarrier(SPEC, TOPIC, gate.egress, new AbortController().signal),
    ).rejects.toThrow("ntfy_401");
  });
});

describe("Basic credentials", () => {
  it("are the user's characters in UTF-8, not a Latin-1 accident", () => {
    const decode = (value: string) =>
      new TextDecoder().decode(
        Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
      );
    expect(decode(basicCredentials("ada", "pw"))).toBe("ada:pw");
    expect(decode(basicCredentials("josé", "päss"))).toBe("josé:päss");
    // btoa alone throws on these.
    expect(() => btoa("用户:пароль")).toThrow();
    expect(decode(basicCredentials("用户", "пароль 🔑"))).toBe(
      "用户:пароль 🔑",
    );
  });

  it("go in the header for a carrier whose user and password are not Latin-1", async () => {
    const seen: (string | null)[] = [];
    const live = stream();
    const gate = gateFor(planUnder(policy(ALLOW_ALL)), async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return live.response();
    });
    const carrier = await ntfyCarrier(
      { ...SPEC, username: "用户", password: "пароль" },
      TOPIC,
      gate.egress,
      new AbortController().signal,
    );
    expect(seen).toEqual([`Basic ${basicCredentials("用户", "пароль")}`]);
    carrier.close();
  });
});
