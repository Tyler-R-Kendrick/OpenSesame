import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { COPY_WATCH, copyFrom } from "./live-join-walk.mjs";

const realWindow = globalThis.window;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  globalThis.window = realWindow;
  if (realNavigator)
    Object.defineProperty(globalThis, "navigator", realNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

/** A page's clipboard: `writeText` answers as the browser would. */
function browser(answer) {
  const taken = [];
  const clipboard = {
    writeText: (text) => {
      taken.push(text);
      return answer(text);
    },
  };
  globalThis.window = {};
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
  });
  return { clipboard, taken };
}

/**
 * The slice of a Playwright page `copyFrom` uses, running its functions in this
 * process against the fake window, so the code under test is the code that runs.
 */
function pageOf(key) {
  return {
    evaluate: async (fn) => fn(),
    waitForFunction: async (fn, arg) => {
      for (let i = 0; i < 50; i++) {
        const found = fn(arg);
        if (found) return { jsonValue: async () => found };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("timed out");
    },
    click: key,
  };
}

test("the watch wraps writeText once, however many times it is installed", async () => {
  const { clipboard, taken } = browser(async () => {});
  COPY_WATCH();
  const wrapped = clipboard.writeText;
  COPY_WATCH();
  assert.equal(clipboard.writeText, wrapped);
  await clipboard.writeText("one");
  assert.deepEqual(taken, ["one"]);
  assert.equal(globalThis.window.__copies.length, 1);
});

test("a page that never had the init script still reads what a key copied", async () => {
  const { clipboard } = browser(async () => {});
  const page = pageOf(null);
  const key = { click: () => clipboard.writeText("osl-offer.abc") };
  assert.equal(await copyFrom(page, key), "osl-offer.abc");
});

test("a page that did install the watch is not wrapped twice", async () => {
  const { clipboard, taken } = browser(async () => {});
  COPY_WATCH();
  const key = { click: () => clipboard.writeText("osl-request.xyz") };
  assert.equal(await copyFrom(pageOf(null), key), "osl-request.xyz");
  assert.deepEqual(taken, ["osl-request.xyz"]);
  assert.equal(globalThis.window.__copies.length, 1);
});

test("a copy made before the call is not the one it waits for", async () => {
  const { clipboard } = browser(async () => {});
  COPY_WATCH();
  await clipboard.writeText("earlier");
  const key = { click: () => clipboard.writeText("later") };
  assert.equal(await copyFrom(pageOf(null), key), "later");
});

test("a copy the browser refuses fails the walk with the browser's reason", async () => {
  const { clipboard } = browser(() =>
    Promise.reject(new Error("NotAllowedError")),
  );
  const key = {
    click: () => clipboard.writeText("osl-offer.abc").catch(() => {}),
  };
  await assert.rejects(
    copyFrom(pageOf(null), key),
    /the browser refused the copy: Error: NotAllowedError/,
  );
});
