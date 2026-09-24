import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  createPinnedFetch,
  pinnedLookup,
  pinnedRequestOptions,
} from "../src/pinned-fetch.mjs";

const VETTED = [{ address: "93.184.216.34", family: 4 }];

function lookupAll(lookup, host, options) {
  return new Promise((resolve, reject) =>
    lookup(host, options, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    ),
  );
}

/** A request stub that answers with `status` and `body`. */
function fakeRequest(status, body = "") {
  const seen = [];
  const requestImpl = (options, onResponse) => {
    seen.push(options);
    const req = new EventEmitter();
    req.destroy = (error) => error && req.emit("error", error);
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = status;
      onResponse(response);
      response.end(body);
    };
    return req;
  };
  return { requestImpl, seen };
}

describe("pinned forge fetch", () => {
  it("answers every lookup from the vetted list only", async () => {
    const lookup = pinnedLookup(VETTED);
    const one = await lookupAll(lookup, "rebind.example", {});
    assert.deepEqual(one, { address: "93.184.216.34", family: 4 });
    const all = await lookupAll(lookup, "anything.else", { all: true });
    assert.deepEqual(all.address, VETTED);
    await assert.rejects(
      lookupAll(lookup, "rebind.example", { family: 6 }),
      /No vetted address/,
    );
  });

  it("keeps the name for SNI and Host while pinning the address", () => {
    const { options, body } = pinnedRequestOptions(
      "https://git.example.org:3000/api/v1/x?ref=main",
      { method: "PUT", headers: { Accept: "application/json" }, body: "{}" },
      VETTED,
    );
    assert.equal(options.hostname, "git.example.org");
    assert.equal(options.servername, "git.example.org");
    assert.equal(options.headers.host, "git.example.org:3000");
    assert.equal(options.headers["content-length"], 2);
    assert.equal(options.path, "/api/v1/x?ref=main");
    assert.equal(options.agent, false);
    assert.equal(body, "{}");
    const literal = pinnedRequestOptions("https://93.184.216.34/", {}, VETTED);
    assert.equal(literal.options.servername, undefined);
    assert.throws(() =>
      pinnedRequestOptions("http://git.example.org/", {}, VETTED),
    );
  });

  it("connects its socket to the vetted address, never the resolver's", async () => {
    // `git.invalid` can never resolve (RFC 6761), so a connection that
    // arrives here was placed by the pinned lookup; the ClientHello still
    // carries the name as SNI.
    const received = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk);
        socket.destroy();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const pinned = createPinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      await assert.rejects(pinned(`https://git.invalid:${port}/api/v1/x`));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const hello = Buffer.concat(received).toString("latin1");
    assert.ok(hello.includes("git.invalid"), "SNI names the host");
  });

  it("refuses a redirect instead of following it", async () => {
    const { requestImpl } = fakeRequest(302);
    const pinned = createPinnedFetch(VETTED, requestImpl);
    await assert.rejects(
      pinned("https://git.example.org/x", { redirect: "error" }),
      /redirect refused/,
    );
  });

  it("returns status and body for an ordinary answer", async () => {
    const { requestImpl, seen } = fakeRequest(201, '{"commit":{"sha":"s"}}');
    const pinned = createPinnedFetch(VETTED, requestImpl);
    const response = await pinned("https://git.example.org/x", {
      method: "PUT",
      body: "{}",
    });
    assert.equal(response.ok, true);
    assert.equal(response.status, 201);
    assert.equal(await response.text(), '{"commit":{"sha":"s"}}');
    assert.equal(seen[0].method, "PUT");
  });
});
