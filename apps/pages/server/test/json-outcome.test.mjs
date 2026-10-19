import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { handleRelayRequest } from "../server.mjs";

// Reflected request/upstream text only ever leaves the relay as JSON that
// cannot be sniffed back into HTML (CodeQL js/reflected-xss): the relay
// pins the content type itself instead of trusting handler headers.

function response() {
  let settle = () => {};
  const finished = new Promise((done) => {
    settle = done;
  });
  return {
    statusCode: 0,
    headers: {},
    body: "",
    finished,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(body) {
      if (body !== undefined) this.body = body;
      settle();
    },
  };
}

function post(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.url = url;
  req.headers = { origin: "http://localhost:5180" };
  return req;
}

describe("relay JSON outcomes", () => {
  it("pins application/json + nosniff on the github-app routes", async () => {
    const res = response();
    handleRelayRequest(
      post("/api/github-app/lookup", { slug: "<script>alert(1)</script>" }),
      res,
    );
    await res.finished;
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "invalid_slug");
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  it("pins application/json + nosniff on the git-backup route", async () => {
    const res = response();
    handleRelayRequest(post("/api/git-backup/put", {}), res);
    await res.finished;
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "missing_fields");
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });
});
