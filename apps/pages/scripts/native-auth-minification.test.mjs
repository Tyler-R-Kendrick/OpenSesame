/** Exercise the real private popup guard after the production minifier runs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { minify } from "terser";
import ts from "typescript";
import { test } from "vitest";

function source(path) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => find(node, predicate));
}
test("production compression preserves isolated popup cancellation and permitted closure", async () => {
  const auth = source(
    "../../../packages/app-core/src/browser/native-auth-session.ts",
  );
  const guard = find(
    auth,
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "closeSessionPopup",
  );
  const config = source("../vite.config.ts");
  const options = find(
    config,
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(config) === "terserOptions",
  );
  assert.ok(guard);
  assert.ok(options);
  const settings = runInNewContext(`(${options.initializer.getText(config)})`);
  assert.equal(settings.compress.pure_getters, true);
  const compiled = ts.transpileModule(guard.getText(auth), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { code } = await minify(
    `${compiled}\nglobalThis.closePopup = closeSessionPopup;`,
    settings,
  );
  assert.ok(code);
  const context = {
    URL,
    window: { location: { origin: "https://app.example" } },
  };
  runInNewContext(code, context);
  let closes = 0;
  let foreign = true;
  let href = "https://app.example/auth/return.html";
  const popup = {
    location: {
      get href() {
        if (foreign) throw new Error("Cross-origin location access denied");
        return href;
      },
    },
    close() {
      closes += 1;
    },
  };
  context.closePopup({ isolated: true, popup });
  assert.equal(closes, 0, "isolated foreign consent remains user-closeable");
  foreign = false;
  context.closePopup({ isolated: true, popup });
  assert.equal(closes, 1, "the same-origin callback closes");
  href = "about:blank";
  context.closePopup({ isolated: true, popup });
  assert.equal(closes, 2, "an unused reservation closes");
  foreign = true;
  context.closePopup({ isolated: false, popup });
  assert.equal(closes, 3, "opener-message flow retains its authorized close");
});
