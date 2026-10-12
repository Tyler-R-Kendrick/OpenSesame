/**
 * The device vocabulary is read as strictly as everything else on a live
 * session's channel (ADR 0195): anything that does not match exactly is
 * dropped, never read as the nearest thing it resembles.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTIONS_MAX,
  INPUT_MAX,
  INPUT_VALUE_MAX,
  ITEMS_MAX,
  OPERATIONS_MAX,
  WANT_MAX,
  isDeviceMessage,
} from "./device-messages.js";
import { readChannelMessage } from "./messages.js";

const wire = (body: Record<string, unknown>) =>
  readChannelMessage(JSON.stringify(body));

const CODE = "A".repeat(22);
const CONNECTION = {
  id: "c-1",
  label: "GitHub",
  provider: "github",
  operations: ["provider.read"],
};

describe("a device's requests", () => {
  it("reads a begin, defaulting to no connections named", () => {
    expect(wire({ t: "dev.begin", req: "r1" })).toEqual({
      t: "dev.begin",
      req: "r1",
      want: [],
    });
    expect(
      wire({ t: "dev.begin", req: "r1", want: ["c-1", "c-2", "c-1"] }),
    ).toEqual({ t: "dev.begin", req: "r1", want: ["c-1", "c-2"] });
  });

  it("refuses a begin that names too many, or something that is not an id", () => {
    const many = Array.from({ length: WANT_MAX + 1 }, (_, i) => `c-${i}`);
    expect(wire({ t: "dev.begin", req: "r1", want: many })).toBeNull();
    expect(wire({ t: "dev.begin", req: "r1", want: ["a b"] })).toBeNull();
    expect(wire({ t: "dev.begin", req: "r1", want: "c-1" })).toBeNull();
    expect(wire({ t: "dev.begin", req: "r1", want: [1] })).toBeNull();
  });

  it("reads a poll only with a well-formed device code", () => {
    expect(wire({ t: "dev.poll", req: "r1", deviceCode: CODE })).toEqual({
      t: "dev.poll",
      req: "r1",
      deviceCode: CODE,
    });
    expect(wire({ t: "dev.poll", req: "r1", deviceCode: "short" })).toBeNull();
    expect(wire({ t: "dev.poll", req: "r1" })).toBeNull();
  });

  it("needs a request id on everything", () => {
    expect(wire({ t: "dev.list" })).toBeNull();
    expect(wire({ t: "dev.list", req: "has space" })).toBeNull();
    expect(wire({ t: "dev.list", req: "x".repeat(33) })).toBeNull();
    expect(wire({ t: "dev.list", req: "r1" })).toEqual({
      t: "dev.list",
      req: "r1",
    });
  });

  it("reads a call and bounds its input", () => {
    expect(
      wire({
        t: "dev.call",
        req: "r1",
        connection: "c-1",
        operation: "provider.repositories.read",
        input: { page: "2" },
      }),
    ).toEqual({
      t: "dev.call",
      req: "r1",
      connection: "c-1",
      operation: "provider.repositories.read",
      input: { page: "2" },
    });
    const call = (extra: Record<string, unknown>) =>
      wire({
        t: "dev.call",
        req: "r1",
        connection: "c-1",
        operation: "provider.read",
        ...extra,
      });
    expect(call({})).toMatchObject({ input: {} });
    expect(call({ operation: "Provider.Read" })).toBeNull();
    expect(call({ operation: "a b" })).toBeNull();
    expect(call({ operation: "a".repeat(200) })).toBeNull();
    expect(call({ connection: "no spaces" })).toBeNull();
    expect(call({ input: [] })).toBeNull();
    expect(call({ input: { n: 1 } })).toBeNull();
    expect(call({ input: { "": "x" } })).toBeNull();
    expect(call({ input: { __proto__x: "x" } })).toBeNull();
    expect(call({ input: { k: "x".repeat(INPUT_VALUE_MAX + 1) } })).toBeNull();
    const wide = Object.fromEntries(
      Array.from({ length: INPUT_MAX + 1 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(call({ input: wide })).toBeNull();
  });

  it("does not let a key named like a prototype through", () => {
    const text = `{"t":"dev.call","req":"r1","connection":"c","operation":"provider.read","input":{"__proto__":"x"}}`;
    expect(readChannelMessage(text)).toBeNull();
  });
});

describe("the owner's answers", () => {
  const code = {
    t: "dev.code",
    req: "r1",
    deviceCode: CODE,
    userCode: "BCDF-GHJK",
    expiresIn: 600,
    interval: 5,
  };

  it("reads a code and refuses a malformed one", () => {
    expect(wire(code)).toEqual(code);
    expect(wire({ ...code, userCode: "bcdf-ghjk" })).toBeNull();
    expect(wire({ ...code, userCode: "BCDFGHJK" })).toBeNull();
    expect(wire({ ...code, deviceCode: "x" })).toBeNull();
    expect(wire({ ...code, expiresIn: 0 })).toBeNull();
    expect(wire({ ...code, expiresIn: 7200 })).toBeNull();
    expect(wire({ ...code, interval: 0 })).toBeNull();
    expect(wire({ ...code, interval: 61 })).toBeNull();
    expect(wire({ ...code, interval: 1.5 })).toBeNull();
  });

  it("reads each state, and wants the extras only the right state carries", () => {
    for (const state of [
      "authorization_pending",
      "access_denied",
      "expired_token",
    ])
      expect(wire({ t: "dev.auth", req: "r1", state })).toEqual({
        t: "dev.auth",
        req: "r1",
        state,
      });
    expect(
      wire({ t: "dev.auth", req: "r1", state: "slow_down", interval: 10 }),
    ).toMatchObject({ interval: 10 });
    expect(wire({ t: "dev.auth", req: "r1", state: "slow_down" })).toBeNull();
    expect(wire({ t: "dev.auth", req: "r1", state: "granted" })).toBeNull();
    expect(
      wire({
        t: "dev.auth",
        req: "r1",
        state: "granted",
        expiresAt: 5,
        connections: [CONNECTION],
      }),
    ).toMatchObject({ state: "granted", connections: [CONNECTION] });
    expect(wire({ t: "dev.auth", req: "r1", state: "approved" })).toBeNull();
  });

  it("bounds connections, their operations and what they are called", () => {
    const conns = (connections: unknown) =>
      wire({ t: "dev.conns", req: "r1", connections });
    expect(conns([CONNECTION])).toEqual({
      t: "dev.conns",
      req: "r1",
      connections: [CONNECTION],
    });
    expect(
      conns(Array.from({ length: CONNECTIONS_MAX + 1 }, () => CONNECTION)),
    ).toBeNull();
    expect(
      conns([
        {
          ...CONNECTION,
          operations: Array.from(
            { length: OPERATIONS_MAX + 1 },
            (_, i) => `op.n${i}`,
          ),
        },
      ]),
    ).toBeNull();
    expect(conns([{ ...CONNECTION, label: "" }])).toBeNull();
    expect(conns([{ ...CONNECTION, label: "a‮b" }])).toBeNull();
    expect(conns([{ ...CONNECTION, provider: "no spaces" }])).toBeNull();
    expect(conns([{ ...CONNECTION, operations: ["Bad Op"] }])).toBeNull();
    expect(conns("c-1")).toBeNull();
  });

  it("reads a result and bounds its lines", () => {
    const result = (extra: Record<string, unknown>) =>
      wire({
        t: "dev.result",
        req: "r1",
        label: "Repos",
        items: [{ id: "r1", label: "opensesame", url: "https://x.test/r" }],
        truncated: false,
        ...extra,
      });
    expect(result({})).toMatchObject({ label: "Repos", truncated: false });
    expect(result({ truncated: "no" })).toBeNull();
    expect(result({ label: "" })).toBeNull();
    expect(
      result({
        items: Array.from({ length: ITEMS_MAX + 1 }, () => ({
          id: "a",
          label: "a",
        })),
      }),
    ).toBeNull();
    expect(result({ items: [{ id: "a", label: "x\u0000y" }] })).toBeNull();
    expect(
      result({ items: [{ id: "a", label: "a", url: "http://x.test" }] }),
    ).toBeNull();
    expect(
      result({ items: [{ id: "a", label: "a", url: "javascript:alert(1)" }] }),
    ).toBeNull();
    expect(result({ items: "none" })).toBeNull();
  });

  it("reads only the errors it knows", () => {
    expect(wire({ t: "dev.error", req: "r1", error: "access_denied" })).toEqual(
      {
        t: "dev.error",
        req: "r1",
        error: "access_denied",
      },
    );
    expect(wire({ t: "dev.error", req: "r1", error: "boom" })).toBeNull();
    expect(wire({ t: "dev.error", req: "r1" })).toBeNull();
  });

  it("does not take an unknown dev message for one", () => {
    expect(wire({ t: "dev.revoke", req: "r1" })).toBeNull();
    expect(wire({ t: "dev.", req: "r1" })).toBeNull();
    expect(isDeviceMessage({ t: "dev.begin" })).toBe(true);
    expect(isDeviceMessage({ t: "reveal" })).toBe(false);
  });
});
