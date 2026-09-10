import assert from "node:assert/strict";
import { test } from "vitest";
import { impeccableDevHtml } from "./impeccable-dev.mjs";

const html = `<meta content="script-src 'self' 'wasm-unsafe-eval'"><!-- impeccable-live-start --><script src="http://localhost:8400/live.js"></script><!-- impeccable-live-end --><script src="/src/main.tsx"></script>`;

test("the picker is admitted only with both a dev server and explicit opt-in", () => {
  assert.match(
    impeccableDevHtml(html, true, true),
    /script-src 'self' http:\/\/localhost:8400/,
  );
  for (const [serving, enabled] of [
    [false, false],
    [false, true],
    [true, false],
  ]) {
    const result = impeccableDevHtml(html, serving, enabled);
    assert.doesNotMatch(result, /localhost:8400/);
    assert.doesNotMatch(result, /impeccable-live/);
    assert.match(result, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(result, /src="\/src\/main.tsx"/);
  }
});

test("upstream CSP injection is removed outside opted-in development", () => {
  const injected = html.replace(
    "script-src 'self'",
    "script-src 'self' http://localhost:8400",
  );
  assert.doesNotMatch(
    impeccableDevHtml(injected, false, true),
    /localhost:8400/,
  );
  assert.match(
    impeccableDevHtml(injected, true, true),
    /crossorigin="anonymous"/,
  );
});
