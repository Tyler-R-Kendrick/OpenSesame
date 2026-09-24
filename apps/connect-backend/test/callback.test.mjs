import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleCallback } from "../src/callback.mjs";

describe("connect callback relay", () => {
  it("forwards params to a loopback return address", () => {
    const outcome = handleCallback(
      "/api/connect/callback?return_to=http%3A%2F%2Flocalhost%3A5180%2FOpenSesame%2Fconnections%3Fconnection%3Dabc&state=xyz",
      "https://relay.example",
    );
    assert.equal(outcome.status, 302);
    assert.match(
      outcome.headers.location,
      /^http:\/\/localhost:5180\/OpenSesame\/connections\?connection=abc&state=xyz$/,
    );
  });

  it("refuses an off-allowlist return address", () => {
    const outcome = handleCallback(
      "/api/connect/callback?return_to=https%3A%2F%2Fevil.example%2F",
      "https://relay.example",
    );
    assert.equal(outcome.status, 400);
  });

  it("accepts its own origin and configured https origins", () => {
    const self = handleCallback(
      "/api/connect/callback?return_to=https%3A%2F%2Frelay.example%2Fdone",
      "https://relay.example",
    );
    assert.equal(self.status, 302);
    process.env.OPENSESAME_CONNECT_APP_ORIGINS = "https://app.example";
    try {
      const configured = handleCallback(
        "/api/connect/callback?return_to=https%3A%2F%2Fapp.example%2Fdone",
        "https://relay.example",
      );
      assert.equal(configured.status, 302);
    } finally {
      process.env.OPENSESAME_CONNECT_APP_ORIGINS = undefined;
    }
  });

  it("refuses non-http schemes", () => {
    const outcome = handleCallback(
      "/api/connect/callback?return_to=javascript%3Aalert(1)",
      "https://relay.example",
    );
    assert.equal(outcome.status, 400);
  });
});
