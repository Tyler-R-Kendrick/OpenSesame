import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { harness, head } from "./native-http-stream.test-support.mjs";
import { bindNativeHTTP } from "./native-http.mjs";

const bounds = { timeout: 2000 };
const STOPPED = "Native HTTPS authorization ended.";
const RESPONSE = "Invalid native HTTPS response.";
const ID = "Invalid or consumed native HTTPS operation ID.";
const CAPACITY = "Native HTTPS operation capacity reached.";

test(
  "headers resolve before body credit and stream retains its original listener/slot",
  bounds,
  async (t) => {
    const h = harness(t);
    const pending = h.open();
    const original = head();
    assert.equal(h.publish(original), true);
    const result = await pending;
    original.headers[0][1] = "changed";
    assert.equal(result.headers[0][1], "text/event-stream");
    assert.equal(h.state.pulls.length, 0);
    assert.equal(getEventListeners(h.caller.signal, "abort").length, 1);
    const read = h.pull();
    const input = new Uint8Array([1, 2, 3]);
    assert.equal(h.state.pulls[0].token, h.state.starts[0].token);
    assert.equal(h.publish({ sequence: 1, body: input, eof: false }), true);
    const chunk = await read;
    input[0] = 9;
    assert.deepEqual(chunk, {
      sequence: 1,
      body: new Uint8Array([1, 2, 3]),
      eof: false,
    });
    const end = h.pull(2);
    assert.equal(
      h.publish({ sequence: 2, body: new Uint8Array(), eof: true }),
      true,
    );
    assert.equal((await end).eof, true);
    assert.equal(getEventListeners(h.caller.signal, "abort").length, 0);
    assert.equal(h.publish({ sequence: 3, body: input, eof: false }), false);
    await assert.rejects(h.pull(3), { message: STOPPED });
  },
);

test(
  "buffered and open streams share four slots and monotonic safe IDs",
  bounds,
  async (t) => {
    const h = harness(t);
    const buffered = h.bridge.nativeHTTP(1, {}, h.authority);
    buffered.catch(() => {});
    const streams = [2, 3, 4].map((id) => h.open(id));
    for (const start of h.state.starts.slice(1))
      assert.equal(h.publish(head(), "", start), true);
    await Promise.all(streams);
    await assert.rejects(h.open(5), { message: CAPACITY });
    await assert.rejects(h.open(4), { message: ID });
    assert.equal(h.state.starts.length, 4);
    h.bridge.cancelHTTP(1);
    await assert.rejects(buffered, { message: STOPPED });
    const next = h.open(6);
    h.caller.abort();
    await assert.rejects(next, { message: STOPPED });
  },
);

test("only one exact ordered credit may be outstanding", bounds, async (t) => {
  const h = harness(t);
  const opened = h.open();
  h.publish(head());
  await opened;
  const first = h.pull();
  await assert.rejects(h.pull(), { message: ID });
  await assert.rejects(first, { message: ID });
  assert.equal(h.state.pulls.length, 1);
  assert.equal(
    h.publish({ sequence: 1, body: new Uint8Array([7]), eof: false }),
    false,
  );
  assert.deepEqual(h.state.cancelled, [1]);
});

test(
  "wrong result sequence, excess chunk and shared memory fail without publication",
  bounds,
  async (t) => {
    for (const packet of [
      { sequence: 2, body: new Uint8Array([1]), eof: false },
      { sequence: 1, body: new Uint8Array(32769), eof: false },
      {
        sequence: 1,
        body: new Uint8Array(new SharedArrayBuffer(1)),
        eof: false,
      },
      {
        sequence: 1,
        body: new Uint8Array([1]),
        eof: false,
        unexpected: "field",
      },
    ]) {
      const h = harness(t);
      const opened = h.open();
      h.publish(head());
      await opened;
      const read = h.pull();
      assert.equal(h.publish(packet), false);
      await assert.rejects(read, { message: RESPONSE });
      assert.equal(h.state.pulls.length, 1);
      h.bridge.closeHTTP();
    }
  },
);

test(
  "the actual accumulated copied body is bounded to four MiB",
  bounds,
  async (t) => {
    const h = harness(t);
    const opened = h.open();
    h.publish(head());
    await opened;
    for (let sequence = 1; sequence <= 128; sequence++) {
      const read = h.pull(sequence);
      assert.equal(
        h.publish({ sequence, body: new Uint8Array(32768), eof: false }),
        true,
      );
      assert.equal((await read).body.byteLength, 32768);
    }
    const excess = h.pull(129);
    assert.equal(
      h.publish({ sequence: 129, body: new Uint8Array([1]), eof: true }),
      false,
    );
    await assert.rejects(excess, { message: RESPONSE });
  },
);

test(
  "foreign token, wrong ID and buffered publisher cannot take a stream",
  bounds,
  async (t) => {
    const h = harness(t);
    const opened = h.open();
    const start = h.state.starts[0];
    assert.equal(start.publish(Object.freeze({ id: 1 }), 1, head(), ""), false);
    assert.equal(start.publish(start.token, 2, head(), ""), false);
    assert.equal(h.state.cancelled.length, 0);
    assert.equal(h.publish(head()), true);
    await opened;
    const buffered = h.bridge.nativeHTTP(2, {}, h.authority);
    buffered.catch(() => {});
    const bufferedStart = h.state.starts[1];
    assert.equal(bufferedStart.publish(start.token, 1, head(), ""), false);
    h.bridge.cancelHTTP(2);
    await assert.rejects(buffered, { message: STOPPED });
    const read = h.pull();
    h.caller.abort();
    await assert.rejects(read, { message: STOPPED });
    assert.equal(
      h.publish({ sequence: 1, body: new Uint8Array(), eof: true }),
      false,
    );
  },
);

test(
  "caller and original node cancellation remove pending credits immediately",
  bounds,
  async (t) => {
    for (const withdrawal of ["caller", "node"]) {
      const h = harness(t);
      const opened = h.open();
      h.publish(head());
      await opened;
      const read = h.pull();
      h[withdrawal].abort();
      await assert.rejects(read, { message: STOPPED });
      assert.equal(getEventListeners(h.caller.signal, "abort").length, 0);
      assert.equal(
        h.publish({ sequence: 1, body: new Uint8Array(), eof: true }),
        false,
      );
      assert.deepEqual(h.state.cancelled, [1]);
      h.bridge.closeHTTP();
    }
  },
);

test(
  "authority withdrawal during header decoding cannot publish the headers",
  bounds,
  async (t) => {
    const h = harness(t);
    const opened = h.open();
    const result = head();
    Object.defineProperty(result, "status", {
      get() {
        h.caller.abort();
        return 200;
      },
    });
    assert.equal(h.publish(result), false);
    await assert.rejects(opened, { message: STOPPED });
  },
);

test(
  "original authority is fenced again immediately before body copy",
  bounds,
  async (t) => {
    const h = harness(t);
    const opened = h.open();
    h.publish(head());
    await opened;
    const read = h.pull();
    const body = new Uint8Array([1]);
    const buffer = body.buffer;
    Object.defineProperty(body, "buffer", {
      get() {
        h.caller.abort();
        return buffer;
      },
    });
    assert.equal(h.publish({ sequence: 1, body, eof: false }), false);
    await assert.rejects(read, { message: STOPPED });
  },
);

test(
  "withdrawal during the real owned copy cannot resolve a stale chunk",
  bounds,
  async (t) => {
    const h = harness(t);
    const opened = h.open();
    h.publish(head());
    await opened;
    const read = h.pull();
    const originalSet = Uint8Array.prototype.set;
    Uint8Array.prototype.set = function (...args) {
      originalSet.apply(this, args);
      h.caller.abort();
    };
    try {
      assert.equal(
        h.publish({ sequence: 1, body: new Uint8Array([1]), eof: false }),
        false,
      );
    } finally {
      Uint8Array.prototype.set = originalSet;
    }
    await assert.rejects(read, { message: STOPPED });
  },
);

test(
  "node generation replacement and captured raw method replacement never recapture",
  bounds,
  async (t) => {
    const h = harness(t);
    h.raw.beginStream = () => assert.fail("replacement adopted");
    h.raw.pull = () => assert.fail("replacement adopted");
    h.owner.generation = Object.freeze({});
    h.owner.signal = new AbortController().signal;
    const opened = h.open();
    assert.equal(h.publish(head()), true);
    await opened;
    const read = h.pull();
    assert.equal(
      h.publish({ sequence: 1, body: new Uint8Array(), eof: true }),
      true,
    );
    await read;
    const invalid = h.open(2, { generation: Object.freeze({}) });
    await assert.rejects(invalid, { message: STOPPED });
    assert.equal(h.state.starts.length, 1);
  },
);

test(
  "original Go Current failure and active provider errors retain bounded meanings",
  bounds,
  async (t) => {
    const h = harness(t);
    const opened = h.open();
    h.publish(head());
    await opened;
    const read = h.pull();
    h.state.goCurrent = false;
    assert.equal(
      h.publish({ sequence: 1, body: new Uint8Array([1]), eof: false }),
      false,
    );
    await assert.rejects(read, { message: ID });
    const other = harness(t);
    const active = other.open();
    other.publish(head());
    await active;
    const pending = other.pull();
    assert.equal(other.publish(null, "network"), false);
    await assert.rejects(pending, {
      message: "Native HTTPS transport failed.",
    });
  },
);

test(
  "invalid headers and unsupported ports do not become empty successes",
  bounds,
  async (t) => {
    for (const changes of [
      { status: 199 },
      { headers: [["Bad\nName", "x"]] },
      { url: "https://user:secret@native.test/sse" },
      { url: "http://native.test/sse" },
      { headers: [["X-Test", "x".repeat(32769)]] },
      { statusText: "OK\r\nprivate" },
    ]) {
      const h = harness(t);
      const opened = h.open();
      assert.equal(h.publish({ ...head(), ...changes }), false);
      await assert.rejects(opened, { message: RESPONSE });
      h.bridge.closeHTTP();
    }
    const owner = {
      generation: Object.freeze({}),
      signal: new AbortController().signal,
      current: () => true,
    };
    const bridge = bindNativeHTTP(
      { begin() {}, current() {}, cancel() {}, close() {} },
      owner,
    );
    t.after(() => bridge.closeHTTP());
    await assert.rejects(bridge.nativeHTTPStream(1, {}, owner), {
      message: "Invalid native HTTPS request.",
    });
  },
);
