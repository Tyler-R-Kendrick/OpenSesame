import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire("/work/package.json");
const { webkit } = require("@playwright/test");
assert.equal(require("@playwright/test/package.json").version, "1.64.1");
const record = (phase, error) => console.log(JSON.stringify({
  phase,
  uid: process.getuid(),
  homedir: homedir(),
  ...(error ? { errorName: error.name, errorMessage: error.message } : {}),
}));
let browser;
let context;
try {
  record("launch");
  browser = await webkit.launch({ headless: true });
  context = await browser.newContext();
  const page = await context.newPage();
  await page.exposeFunction("recordStoragePhase", (phase) => record(phase));
  await page.route("https://storage-compat.opensesame.test/", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><meta charset=utf-8><title>Owned storage compatibility fixture</title>",
  }));
  await page.goto("https://storage-compat.opensesame.test/");
  const result = await page.evaluate(async () => {
    const name = "opensesame-browser-storage-compat.txt";
    const expected = "harmless owned compatibility fixture";
    let phase = "secure-context";
    let root;
    let created = false;
    let writable;
    const step = async (next) => {
      phase = next;
      await window.recordStoragePhase(next);
    };
    try {
      if (!isSecureContext) throw new Error("Fixture requires a secure context");
      await step("getDirectory");
      root = await navigator.storage.getDirectory();
      await step("getFileHandle");
      const handle = await root.getFileHandle(name, { create: true });
      created = true;
      await step("createWritable");
      writable = await handle.createWritable();
      await step("write");
      await writable.write(expected);
      await step("close");
      await writable.close();
      writable = undefined;
      await step("readback");
      if (await (await handle.getFile()).text() !== expected)
        throw new Error("Fixture readback differs");
      await step("remove");
      await root.removeEntry(name);
      created = false;
      await step("passed");
      return { ok: true };
    } catch (error) {
      const failure = { ok: false, phase, errorName: error.name, errorMessage: error.message };
      if (writable) await writable.abort().catch(() => {});
      if (created) await root.removeEntry(name).catch(() => {});
      return failure;
    }
  });
  if (!result.ok) {
    record(result.phase, { name: result.errorName, message: result.errorMessage });
    process.exitCode = 1;
  }
} catch (error) {
  record("harness", error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
}
