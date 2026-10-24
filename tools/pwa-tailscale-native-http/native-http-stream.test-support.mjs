import assert from "node:assert/strict";
import { bindNativeHTTP } from "./native-http.mjs";

export const head = () => ({
  status: 200,
  statusText: "OK",
  url: "https://native.test/sse",
  headers: [["Content-Type", "text/event-stream"]],
});

// Executes the real SDK binding against an original-port ownership fixture.
// This is not a Go/WASM/network/physical-drain success claim.
export function harness(t) {
  const node = new AbortController();
  const caller = new AbortController();
  const generation = Object.freeze({});
  const state = {
    allowed: true,
    goCurrent: true,
    code: "",
    pulls: [],
    starts: [],
    cancelled: [],
    closed: 0,
  };
  const raw = {
    begin(id, request, token, publish) {
      state.starts.push({ id, request, token, publish, buffered: true });
      return state.code;
    },
    beginStream(id, request, token, publish) {
      assert.equal(this, raw);
      state.starts.push({ id, request, token, publish });
      return state.code;
    },
    pull(id, sequence, token) {
      assert.equal(this, raw);
      state.pulls.push({ id, sequence, token });
      return state.code;
    },
    current() {
      assert.equal(this, raw);
      return state.goCurrent;
    },
    cancel(id) {
      state.cancelled.push(id);
      return true;
    },
    close() {
      state.closed++;
    },
  };
  const owner = {
    generation,
    signal: node.signal,
    current: () => state.allowed,
  };
  const bridge = bindNativeHTTP(raw, owner);
  const authority = {
    generation,
    signal: caller.signal,
    current: () => state.allowed,
  };
  t.after(() => bridge.closeHTTP());
  function open(id = 1, changes = {}) {
    const promise = bridge.nativeHTTPStream(
      id,
      { method: "GET", url: "https://native.test/sse" },
      { ...authority, ...changes },
    );
    promise.catch(() => {});
    return promise;
  }
  function publish(result, code = "", start = state.starts[0]) {
    return start.publish(start.token, start.id, result, code);
  }
  function pull(sequence = 1, id = 1) {
    const promise = bridge.pullHTTP(id, sequence);
    promise.catch(() => {});
    return promise;
  }
  return {
    node,
    caller,
    state,
    raw,
    owner,
    authority,
    generation,
    bridge,
    open,
    publish,
    pull,
  };
}
