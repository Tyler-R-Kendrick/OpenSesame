import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import handler from "../../api/github-app/webhook.mjs";
import { githubAppRelayPlugin } from "../../scripts/github-app-relay-plugin.mjs";
import {
  MAX_INBOUND_BODY_BYTES,
  PayloadTooLargeError,
  readRawBody,
} from "../read-body.mjs";
import { handleRelayRequest } from "../server.mjs";

function response() {
  let resolve = () => {};
  const finished = new Promise((done) => {
    resolve = done;
  });
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  return {
    statusCode: 0,
    headers: {},
    body: "",
    finished,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body ?? "";
      finish();
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(body) {
      if (body !== undefined) this.body = body;
      finish();
    },
  };
}

function streamingRequest(chunks, fields = {}) {
  const req = Readable.from(chunks);
  req.method = fields.method ?? "POST";
  req.url = fields.url ?? "/api/github-app/webhook";
  req.headers = fields.headers ?? {};
  if ("body" in fields) req.body = fields.body;
  return req;
}

describe("inbound relay body ceiling", () => {
  it("reads a body at the ceiling and rejects one byte past it", async () => {
    const atLimit = Buffer.alloc(MAX_INBOUND_BODY_BYTES, 0x61);
    const ok = await readRawBody(streamingRequest([atLimit]));
    assert.equal(ok.length, MAX_INBOUND_BODY_BYTES);

    const over = streamingRequest([
      Buffer.alloc(MAX_INBOUND_BODY_BYTES + 1, 0x62),
    ]);
    await assert.rejects(readRawBody(over), PayloadTooLargeError);
    assert.equal(over.destroyed, true);
  });

  it("rejects a buffered string or buffer without keeping it", async () => {
    const huge = "x".repeat(MAX_INBOUND_BODY_BYTES + 1);
    await assert.rejects(
      readRawBody(streamingRequest([], { body: huge })),
      PayloadTooLargeError,
    );
    await assert.rejects(
      readRawBody(streamingRequest([], { body: Buffer.from(huge) })),
      PayloadTooLargeError,
    );
  });

  it("rejects an async iterable that has no event emitter", async () => {
    const req = {
      destroyed: false,
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(MAX_INBOUND_BODY_BYTES + 1);
      },
      destroy() {
        this.destroyed = true;
      },
    };
    await assert.rejects(readRawBody(req), PayloadTooLargeError);
    assert.equal(req.destroyed, true);
  });

  it("answers 413 from the Vercel webhook before the handler runs", async () => {
    const res = response();
    await handler(
      streamingRequest([Buffer.alloc(MAX_INBOUND_BODY_BYTES + 1)]),
      res,
    );
    assert.equal(res.statusCode, 413);
    assert.equal(res.body, "body_too_large");
  });

  it("answers 405 for a webhook GET without reading the body", async () => {
    let read = false;
    const req = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    req.method = "GET";
    req.headers = {};
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(read, false);
  });

  it("answers 413 from the node relay and still reports invalid JSON", async () => {
    const tooLarge = response();
    handleRelayRequest(
      streamingRequest([Buffer.alloc(MAX_INBOUND_BODY_BYTES + 1)], {
        url: "/api/git-backup/put",
      }),
      tooLarge,
    );
    await tooLarge.finished;
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.body, "body_too_large");

    const webhook = response();
    handleRelayRequest(
      streamingRequest([Buffer.alloc(MAX_INBOUND_BODY_BYTES + 8)], {
        url: "/api/github-app/webhook",
      }),
      webhook,
    );
    await webhook.finished;
    assert.equal(webhook.statusCode, 413);

    const invalid = response();
    handleRelayRequest(
      streamingRequest([Buffer.from("{")], { url: "/api/git-backup/put" }),
      invalid,
    );
    await invalid.finished;
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.body).error, "invalid_json");
  });

  it("answers 413 from the dev relay and does not call the webhook handler", async () => {
    let middleware;
    githubAppRelayPlugin().configureServer({
      middlewares: {
        use(fn) {
          middleware = fn;
        },
      },
    });
    const res = response();
    middleware(
      streamingRequest([Buffer.alloc(MAX_INBOUND_BODY_BYTES + 1)], {
        url: "/api/github-app/webhook",
      }),
      res,
      () => {
        throw new Error("oversized webhook must not fall through");
      },
    );
    await res.finished;
    assert.equal(res.statusCode, 413);
    assert.equal(res.body, "body_too_large");

    const invalid = response();
    middleware(
      streamingRequest([Buffer.from("not-json")], {
        url: "/api/git-backup/put",
      }),
      invalid,
      () => {
        throw new Error("git backup must not fall through");
      },
    );
    await invalid.finished;
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.body).error, "invalid_json");
  });
});
