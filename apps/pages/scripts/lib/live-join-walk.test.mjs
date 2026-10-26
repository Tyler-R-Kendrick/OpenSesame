import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  COPY_WATCH,
  copyFrom,
  joinerAsks,
  ownerAdmitsByHand,
} from "./live-join-walk.mjs";

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

function admissionFixture() {
  const { clipboard } = browser(async () => {});
  const events = [];
  let admitted = false;
  const sas = "1234-5678-9abc-def0";
  const match = {
    or() {
      return this;
    },
    first() {
      return this;
    },
    async waitFor() {},
    async isVisible() {
      return true;
    },
    async click() {
      events.push("admit");
      admitted = true;
    },
  };
  const copy = {
    async waitFor() {},
    click: () => clipboard.writeText("osl-reply.fixture"),
  };
  const panel = {
    getByLabel: () => ({ async fill() {} }),
    getByRole(_role, { name }) {
      if (name === "Read the request")
        return {
          async click() {
            events.push("read");
          },
        };
      if (name.startsWith("Copy the reply")) return copy;
      return match;
    },
    locator: () => ({
      first() {
        return this;
      },
      async innerText() {
        assert.equal(admitted, false, "The SAS exists only before admission");
        events.push("sas");
        return sas;
      },
    }),
  };
  return { panel, events, sas };
}

test("manual admission compares both SAS values before retiring the asking row", async () => {
  const { panel, events, sas } = admissionFixture();
  const reply = await ownerAdmitsByHand(pageOf(null), panel, "request", "Ada", {
    async beforeAdmit() {
      assert.equal(
        await panel.locator(".vault-row .live-sas").innerText(),
        sas,
      );
      events.push("compared");
    },
  });
  assert.equal(reply, "osl-reply.fixture");
  assert.deepEqual(events, ["read", "sas", "compared", "sas", "admit"]);
});

test("a refused SAS comparison cannot admit the person or copy a reply", async () => {
  const { panel, events } = admissionFixture();
  await assert.rejects(
    ownerAdmitsByHand(pageOf(null), panel, "request", "Ada", {
      beforeAdmit() {
        throw new Error("SAS values differ");
      },
    }),
    /SAS values differ/,
  );
  assert.deepEqual(events, ["read"]);
});

test("open admission waits for the automatic reply without approving a transient SAS row", async () => {
  const { panel, events } = admissionFixture();
  const reply = await ownerAdmitsByHand(pageOf(null), panel, "request", "Ada", {
    admit: false,
    beforeAdmit() {
      throw new Error("Open admission must not request manual comparison");
    },
  });
  assert.equal(reply, "osl-reply.fixture");
  assert.deepEqual(events, ["read"]);
});

function requestFixture() {
  const { clipboard, taken } = browser(async () => {});
  const seen = { asked: false, choice: null, automatic: false, manual: false };
  const field = {
    async waitFor() {},
    async fill() {},
    async isVisible() {
      return false;
    },
  };
  const advanced = {
    filter() {
      return this;
    },
    async getAttribute() {
      return "";
    },
  };
  const page = {
    ...pageOf(null),
    async goto() {},
    getByLabel: () => field,
    locator: () => advanced,
    getByRole(role, { name, exact }) {
      if (role === "heading" || name === "Apply configuration") return field;
      if (role === "checkbox") {
        assert.ok(name.test("Pair through relay.example.test"));
        return {
          async setChecked(value) {
            seen.choice = value;
          },
        };
      }
      if (name === "Ask to join")
        return {
          async click() {
            seen.asked = true;
          },
        };
      if (role === "img") {
        assert.equal(
          name,
          "The owner can see your request. Waiting for them to let you in.",
        );
        assert.equal(exact, true);
        return {
          async waitFor() {
            assert.equal(seen.asked, true);
            assert.equal(seen.choice, true);
            seen.automatic = true;
          },
        };
      }
      assert.equal(name, "Copy your join request");
      return {
        async waitFor() {
          seen.manual = true;
        },
        click: () => clipboard.writeText("osl-request.fixture"),
      };
    },
  };
  return { page, seen, taken };
}

test("automatic carriers require the actual waiting acknowledgement without a manual copy", async () => {
  const { page, seen, taken } = requestFixture();
  assert.equal(
    await joinerAsks(page, {
      link: "https://app.example.test/",
      name: "Ada",
      routes: true,
      automatic: true,
    }),
    "",
  );
  assert.deepEqual(seen, {
    asked: true,
    choice: true,
    automatic: true,
    manual: false,
  });
  assert.deepEqual(taken, []);
});

test("declining a carrier still requires copying the real manual request", async () => {
  const { page, seen, taken } = requestFixture();
  assert.equal(
    await joinerAsks(page, {
      link: "https://app.example.test/",
      name: "Ada",
      routes: false,
    }),
    "osl-request.fixture",
  );
  assert.deepEqual(seen, {
    asked: true,
    choice: false,
    automatic: false,
    manual: true,
  });
  assert.deepEqual(taken, ["osl-request.fixture"]);
});
