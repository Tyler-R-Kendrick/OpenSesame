// A small Chrome DevTools Protocol client, for the one page Playwright cannot
// see: the extension's toolbar popup.
//
// The popup is not a tab. Its messages reach the background with no `tab` on
// the sender, which is what the background insists on before it answers
// `status`, `trigger`, `enable` or `disable` (a page in a tab is refused as a
// `forbidden_sender`, correctly), so the same `popup.html` opened as a tab
// proves nothing. `chrome.action.openPopup()` opens the real one; Chromium
// exposes it as a `page` target that Playwright's own connection never
// surfaces, so this attaches to it directly over the browser's debugging port
// (`DevToolsActivePort`, written into the profile) using Node's WebSocket.
import { readFileSync } from "node:fs";
import path from "node:path";

/** Connect to the browser's debugging endpoint. */
export async function connectBrowser(profileDir) {
  const [port, endpoint] = readFileSync(
    path.join(profileDir, "DevToolsActivePort"),
    "utf8",
  )
    .trim()
    .split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("no debugging endpoint")),
      {
        once: true,
      },
    );
  });
  let next = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const done = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) done?.reject(new Error(message.error.message));
      else done?.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  return {
    send(method, params, sessionId) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        socket.send(
          JSON.stringify({ id, method, params: params ?? {}, sessionId }),
        );
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a `popup.html` target that is not one of `known`, and attach to it. */
export async function attachPopup(browser, popupUrl, known = new Set()) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await browser.send("Target.getTargets");
    const target = targetInfos.find(
      (info) =>
        info.type === "page" &&
        info.url === popupUrl &&
        !known.has(info.targetId),
    );
    if (target) return openPanel(browser, target.targetId);
    await sleep(100);
  }
  throw new Error("the popup did not open");
}

async function openPanel(browser, targetId) {
  const { sessionId } = await browser.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const call = (method, params) => browser.send(method, params, sessionId);
  const console_ = [];
  const errors = [];
  browser.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === "Runtime.consoleAPICalled") {
      console_.push(
        event.params.args
          .map((arg) => String(arg.value ?? arg.description))
          .join(" "),
      );
    } else if (event.method === "Runtime.exceptionThrown") {
      errors.push(event.params.exceptionDetails.text);
    }
  });
  await call("Runtime.enable");

  /** Run `fn(...args)` in the popup and return its (awaited) value. */
  async function evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (exceptionDetails)
      throw new Error(
        exceptionDetails.exception?.description ?? "evaluate failed",
      );
    return result.value;
  }

  return {
    targetId,
    console: console_,
    errors,
    evaluate,
    /** Poll until `fn(...args)` is truthy in the popup. */
    async waitFor(fn, ...args) {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await evaluate(fn, ...args)) return;
        await sleep(100);
      }
      throw new Error(`the popup never satisfied ${String(fn).slice(0, 120)}`);
    },
    /** A real left click at the middle of `selector`: it carries a user gesture. */
    async click(selector) {
      const box = await evaluate((sel) => {
        const element = document.querySelector(sel);
        if (!element || element.hidden || element.disabled) return null;
        element.scrollIntoView({ block: "center" });
        const { left, top, width, height } = element.getBoundingClientRect();
        return width > 0 && height > 0
          ? { x: left + width / 2, y: top + height / 2 }
          : null;
      }, selector);
      if (!box) throw new Error(`${selector} is not there to press`);
      const at = { ...box, button: "left", clickCount: 1 };
      await call("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x,
        y: box.y,
      });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    },
    async close() {
      await browser
        .send("Target.closeTarget", { targetId })
        .catch(() => undefined);
    },
  };
}
