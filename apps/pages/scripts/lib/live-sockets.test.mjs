import assert from "node:assert/strict";
import { test } from "vitest";
import { openTo, ownerReleases, released } from "./live-sockets.mjs";

/** A page's socket as Playwright describes it: a url and whether it closed. */
function socket(url) {
  const made = {
    closed: false,
    url: () => url,
    isClosed: () => made.closed,
  };
  return made;
}

test("names only the open sockets that go to the host", () => {
  const near = socket("wss://127.0.0.1:4001/");
  const gone = socket("wss://127.0.0.1:4001/");
  const far = socket("wss://127.0.0.1:4002/");
  gone.closed = true;
  assert.deepEqual(openTo([near, gone, far], "127.0.0.1:4001"), [near]);
});

test("waits for a close handshake that is still going, then reports none", async () => {
  const closing = socket("wss://127.0.0.1:4001/");
  setTimeout(() => {
    closing.closed = true;
  }, 60);
  const started = Date.now();
  const left = await released([closing], "127.0.0.1:4001", 2000);
  assert.deepEqual(left, []);
  assert.ok(Date.now() - started >= 50, "it did not wait for the close");
});

test("does not wait at all when nothing is open to the host", async () => {
  const started = Date.now();
  const left = await released([socket("wss://elsewhere:1/")], "127.0.0.1:4001");
  assert.deepEqual(left, []);
  assert.ok(Date.now() - started < 100);
});

test("gives up after the time it was given, and says what stayed open", async () => {
  const stuck = socket("wss://127.0.0.1:4001/");
  const left = await released([stuck], "127.0.0.1:4001", 80);
  assert.deepEqual(left, ["wss://127.0.0.1:4001/"]);
});

test("the owner is released from a carrier once its sockets to it are closed", async () => {
  const held = [socket("wss://127.0.0.1:4001/")];
  const owner = { released: (host, ms) => released(held, host, ms) };
  setTimeout(() => {
    held[0].closed = true;
  }, 60);
  assert.deepEqual(
    await ownerReleases(owner, { url: "wss://127.0.0.1:4001/" }),
    [],
  );
  assert.equal(held[0].closed, true);
});

test("a carrier with no address is nothing the owner holds a socket to", async () => {
  const owner = {
    released: () => {
      throw new Error("asked a page about a carrier with no address");
    },
  };
  assert.deepEqual(await ownerReleases(owner, { url: "" }), []);
});
