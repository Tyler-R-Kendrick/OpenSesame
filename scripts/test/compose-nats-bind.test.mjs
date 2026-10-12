import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("compose publishes NATS on loopback only", () => {
  const text = readFileSync(
    new URL("../../ops/compose/docker-compose.yml", import.meta.url),
    "utf8",
  );
  assert.match(text, /127\.0\.0\.1:4222:4222/u);
  assert.doesNotMatch(text, /^\s*-\s*"4222:4222"/mu);
});
