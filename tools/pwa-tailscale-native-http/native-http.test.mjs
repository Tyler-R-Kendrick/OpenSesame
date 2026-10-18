import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { bindNativeHTTP } from "./native-http.mjs";

const STOPPED = "Native HTTPS authorization ended.";
const NETWORK = "Native HTTPS transport failed.";
const ID = "Invalid or consumed native HTTPS operation ID.";
const CAPACITY = "Native HTTPS operation capacity reached.";
const INPUT = "Invalid native HTTPS request.";
const bounds = { timeout: 2_000 };

// Admission/ownership double only. It never creates a Response or certifies a
// positive Go/WASM/HTTP exchange; actual TLS proof belongs to the pinned Go tests.
function harness(t) {
  const node = new AbortController();
  const generation = Object.freeze({});
  const calls = { begun: [], cancelled: [], currents: [], closed: 0 };
  const behavior = {
    code: "",
    throwBegin: false,
    throwCancel: false,
    onClose: null,
  };
  const raw = {
    begin(id, request, token, publish) {
      if (behavior.throwBegin) throw new Error("private callback detail");
      calls.begun.push({ id, request, token, publish });
      return behavior.code;
    },
    current(id) {
      calls.currents.push(id);
      return false;
    },
    cancel(id) {
      calls.cancelled.push(id);
      if (behavior.throwCancel) throw new Error("private cancellation detail");
      return false;
    },
    close() {
      calls.closed++;
      behavior.onClose?.();
    },
  };
  const owner = { generation, signal: node.signal, current: () => true };
  const bridge = bindNativeHTTP(raw, owner);
  t.after(() => bridge.closeHTTP());
  function start(id, changes = {}) {
    const caller = new AbortController();
    const authority = {
      generation,
      signal: caller.signal,
      current: () => true,
      ...changes,
    };
    const promise = bridge.nativeHTTP(id, {}, authority);
    // Retain the original outcome even when teardown withdraws a pending call.
    const outcome = promise.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, message: error.message }),
    );
    return { caller, authority, outcome };
  }
  return { node, owner, raw, bridge, behavior, calls, start, generation };
}

async function refused(start, message) {
  assert.deepEqual(await start.outcome, { ok: false, message });
}

test(
  "unsafe IDs never reach Go and consumed IDs never restart",
  bounds,
  async (t) => {
    const h = harness(t);
    for (const id of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
    ])
      await refused(h.start(id), ID);
    assert.equal(h.calls.begun.length, 0);
    assert.equal(h.calls.cancelled.length, 0);
    const first = h.start(1);
    await refused(h.start(1), ID);
    assert.equal(h.bridge.cancelHTTP(1), true);
    await refused(first, STOPPED);
    await refused(h.start(1), ID);
  },
);

test(
  "future cancel burns ID without a pending token or callback reuse",
  bounds,
  async (t) => {
    const h = harness(t);
    assert.equal(h.bridge.cancelHTTP(9), false);
    assert.deepEqual(h.calls.cancelled, [9]);
    await refused(h.start(9), ID);
    await refused(h.start(8), ID);
    const next = h.start(10);
    h.bridge.cancelHTTP(10);
    await refused(next, STOPPED);
  },
);

test(
  "four pending tokens refuse a fifth and preserve Go capacity refusal",
  bounds,
  async (t) => {
    const h = harness(t);
    const starts = [1, 2, 3, 4].map((id) => h.start(id));
    await refused(h.start(5), CAPACITY);
    assert.equal(h.calls.begun.length, 4);
    assert.deepEqual(h.calls.cancelled, [5]);
    h.bridge.cancelHTTP(1);
    await refused(starts[0], STOPPED);
    h.behavior.code = "capacity";
    await refused(h.start(6), CAPACITY);
    h.bridge.closeHTTP();
    for (const start of starts.slice(1)) await refused(start, STOPPED);
  },
);

test(
  "caller cancellation removes exact listener and refuses late completion",
  bounds,
  async (t) => {
    const h = harness(t);
    const first = h.start(1);
    const record = h.calls.begun[0];
    assert.equal(getEventListeners(first.caller.signal, "abort").length, 1);
    first.caller.abort();
    await refused(first, STOPPED);
    assert.equal(getEventListeners(first.caller.signal, "abort").length, 0);
    assert.equal(
      record.publish(record.token, record.id, undefined, "network"),
      false,
    );
    assert.equal(record.publish(record.token, record.id, undefined, ""), false);
    assert.deepEqual(h.calls.currents, []);
  },
);

test(
  "one original token cannot complete or cancel another operation",
  bounds,
  async (t) => {
    const h = harness(t);
    const a = h.start(1);
    const b = h.start(2);
    const first = h.calls.begun[0];
    const second = h.calls.begun[1];
    const foreign = new Proxy(
      {},
      {
        get() {
          throw new Error("foreign getter");
        },
      },
    );
    assert.equal(first.publish(foreign, first.id, undefined, "network"), false);
    assert.equal(
      first.publish(Object.freeze({ id: 1 }), first.id, undefined, "network"),
      false,
    );
    h.bridge.cancelHTTP(1);
    await refused(a, STOPPED);
    assert.equal(
      first.publish(first.token, first.id, undefined, "network"),
      false,
    );
    assert.equal(
      second.publish(second.token, second.id, undefined, "network"),
      true,
    );
    await refused(b, NETWORK);
  },
);

test(
  "original Go current fence refuses purported completion after copying",
  bounds,
  async (t) => {
    const h = harness(t);
    const start = h.start(1);
    const record = h.calls.begun[0];
    h.raw.current = () => true; // The captured port must not adopt this replacement.
    record.publish(record.token, record.id, undefined, "");
    await refused(start, STOPPED);
    assert.deepEqual(h.calls.currents, [1]);
  },
);

test(
  "final lease callback cancellation wins before resolve",
  bounds,
  async (t) => {
    const h = harness(t);
    let withdraw = false;
    const start = h.start(1, {
      current() {
        if (withdraw) h.bridge.cancelHTTP(1);
        return true;
      },
    });
    withdraw = true;
    const record = h.calls.begun[0];
    record.publish(record.token, record.id, undefined, "");
    await refused(start, STOPPED);
    assert.deepEqual(h.calls.currents, []);
  },
);

test(
  "throwing final owner check rejects with a fixed message",
  bounds,
  async (t) => {
    const h = harness(t);
    let throwNow = false;
    const start = h.start(1, {
      current() {
        if (throwNow) throw new Error("private lease detail");
        return true;
      },
    });
    throwNow = true;
    const record = h.calls.begun[0];
    record.publish(record.token, record.id, undefined, "");
    await refused(start, STOPPED);
  },
);

test(
  "captured node abort closes every promise before Go close",
  bounds,
  async (t) => {
    const h = harness(t);
    const a = h.start(1);
    const b = h.start(2);
    h.owner.signal = new AbortController().signal;
    h.owner.generation = Object.freeze({});
    h.owner.current = () => true;
    h.behavior.onClose = () => {
      for (const record of h.calls.begun)
        assert.equal(
          record.publish(record.token, record.id, undefined, "network"),
          false,
        );
    };
    h.node.abort();
    await refused(a, STOPPED);
    await refused(b, STOPPED);
    assert.equal(h.calls.closed, 1);
    assert.equal(getEventListeners(h.node.signal, "abort").length, 0);
    await refused(h.start(3), STOPPED);
    assert.equal(h.bridge.closeHTTP(), true);
    assert.equal(h.calls.closed, 1);
  },
);

test(
  "changed generation and already-cancelled caller cannot begin",
  bounds,
  async (t) => {
    const h = harness(t);
    await refused(h.start(1, { generation: Object.freeze({}) }), STOPPED);
    const caller = new AbortController();
    caller.abort();
    await refused(h.start(2, { signal: caller.signal }), STOPPED);
    assert.equal(h.calls.begun.length, 0);
    assert.deepEqual(h.calls.cancelled, [1, 2]);
  },
);

test(
  "raw callback failures and malformed acknowledgements never publish",
  bounds,
  async (t) => {
    const h = harness(t);
    h.behavior.throwBegin = true;
    h.behavior.throwCancel = true;
    await refused(h.start(1), NETWORK);
    h.behavior.throwBegin = false;
    h.behavior.code = undefined;
    await refused(h.start(2), NETWORK);
    h.behavior.code = "toString";
    await refused(h.start(3), NETWORK);
  },
);

test(
  "invalid authority shape is rejected and consumed without begin",
  bounds,
  async (t) => {
    const h = harness(t);
    await refused(h.start(1, { current: null }), INPUT);
    await refused(h.start(1), ID);
    await refused(h.start(2, { signal: null }), INPUT);
    assert.equal(h.calls.begun.length, 0);
  },
);

test(
  "constructor errors are fixed and contain no callback details",
  bounds,
  () => {
    assert.throws(() => bindNativeHTTP({}, {}), { message: INPUT });
    const raw = new Proxy(
      {},
      {
        get() {
          throw new Error("private constructor detail");
        },
      },
    );
    assert.throws(() => bindNativeHTTP(raw, {}), { message: INPUT });
  },
);
