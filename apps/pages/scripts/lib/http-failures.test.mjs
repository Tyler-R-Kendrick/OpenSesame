import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { observeHttpFailures } from "./http-failures.mjs";

const expected = "https://pages.example/app/vault/health";
const browser404 =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";
function fixture({ expectedFallbackUrl } = { expectedFallbackUrl: expected }) {
  const page = new EventEmitter();
  const frame = {};
  page.mainFrame = () => frame;
  const log = [];
  observeHttpFailures(
    page,
    (kind, detail) => log.push({ kind, detail }),
    expectedFallbackUrl,
  );
  return {
    log,
    response(url = expected, type = "document", main = true, status = 404) {
      page.emit("response", {
        url: () => url,
        status: () => status,
        request: () => ({
          isNavigationRequest: () => type === "document",
          resourceType: () => type,
          frame: () => (main ? frame : {}),
        }),
      });
    },
    console(url = expected, text = browser404) {
      page.emit("console", {
        type: () => "error",
        text: () => text,
        location: () => ({ url }),
      });
    },
  };
}
test("admits only the observed exact top-level fallback and one corresponding console error", () => {
  const f = fixture();
  f.response();
  f.console();
  f.console();
  f.response();
  assert.deepEqual(
    f.log.map((entry) => entry.kind),
    [
      "EXPECTED-FALLBACK",
      "EXPECTED-FALLBACK-CONSOLE",
      "console-error",
      "HTTP-ERROR",
    ],
  );
});

test("without a fallback allowance every404 and console error fails", () => {
  const f = fixture({});
  f.response();
  f.console();
  assert.deepEqual(
    f.log.map((entry) => entry.kind),
    ["HTTP-ERROR", "console-error"],
  );
});
test("rejects asset, unrelated navigation, subframe and server failures", () => {
  const f = fixture();
  f.response("https://pages.example/app/missing.js", "script");
  f.response(`${expected}/other`);
  f.response(expected, "document", false);
  f.response(expected, "document", true, 500);
  assert.equal(f.log.filter((entry) => entry.kind === "HTTP-ERROR").length, 4);
});
test("a404 string alone, wrong console URL, or different error is never sufficient", () => {
  const f = fixture();
  f.console();
  f.response();
  f.console(`${expected}/missing.css`);
  f.console(expected, "application failed with404 (Not Found)");
  assert.equal(
    f.log.filter((entry) => entry.kind === "console-error").length,
    3,
  );
});
