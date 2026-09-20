import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { handleManage } from "../manage.mjs";

const original = {
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  OPENSESAME_CONNECT_APP_ORIGINS: process.env.OPENSESAME_CONNECT_APP_ORIGINS,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("handleManage", () => {
  it("refuses unknown origins", async () => {
    const outcome = await handleManage({
      method: "GET",
      path: "/api/connect/connectors",
      origin: "https://evil.example",
    });
    assert.equal(outcome.status, 403);
  });

  it("refuses a missing Origin instead of treating it as allowed", async () => {
    const outcome = await handleManage({
      method: "GET",
      path: "/api/connect/connectors",
      origin: "",
    });
    assert.equal(outcome.status, 403);
  });

  it("reports missing VERCEL_TOKEN instead of asking the browser", async () => {
    Reflect.deleteProperty(process.env, "VERCEL_TOKEN");
    process.env.OPENSESAME_CONNECT_APP_ORIGINS = "http://localhost:5180";
    const outcome = await handleManage({
      method: "GET",
      path: "/api/connect/connectors",
      origin: "http://localhost:5180",
    });
    assert.equal(outcome.status, 503);
    const body = JSON.parse(outcome.body);
    assert.equal(body.error.code, "unconfigured");
  });
});
