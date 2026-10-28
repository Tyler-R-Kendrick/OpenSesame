import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { persistentLiveBrowser } from "./persistent-live-browser.mjs";

function engine({ beforeLaunch, failClose = false } = {}) {
  const launches = [];
  const browserType = {
    name: () => "webkit",
    async launchPersistentContext(directory, options) {
      const made = { directory, options, closes: 0, blankClosed: false };
      launches.push(made);
      await beforeLaunch?.(made);
      return {
        pages: () => [
          {
            close: async () => {
              made.blankClosed = true;
            },
          },
        ],
        close: async () => {
          made.closes++;
          if (failClose) throw new Error("process cleanup refused");
        },
      };
    },
  };
  return { browserType, launches };
}

const absent = (directory) =>
  assert.rejects(access(directory), { code: "ENOENT" });

describe("persistent WebKit live peers", () => {
  it("keeps each person's profile and lifecycle separate while forwarding device options", async () => {
    const { browserType, launches } = engine();
    const browser = persistentLiveBrowser(browserType, { headless: true });
    try {
      assert.equal(browser.browserType().name(), "webkit");
      const options = {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
      };
      const owner = await browser.newContext(options);
      const joiner = await browser.newContext(options);
      const [a, b] = launches.map((launch) => launch.directory);
      assert.notEqual(a, b);
      assert.deepEqual(browser.contexts(), [owner, joiner]);
      for (const launch of launches) {
        assert.deepEqual(launch.options, { headless: true, ...options });
        assert.equal(launch.blankClosed, true);
      }
      await writeFile(path.join(a, "vault"), "owner state");
      await assert.rejects(readFile(path.join(b, "vault")), { code: "ENOENT" });
      await writeFile(path.join(b, "vault"), "joiner state");
      await owner.close();
      await owner.close();
      await absent(a);
      assert.equal(
        await readFile(path.join(b, "vault"), "utf8"),
        "joiner state",
      );
      assert.deepEqual(browser.contexts(), [joiner]);
      assert.equal(launches[0].closes, 1);
      await browser.close();
      await absent(b);
      assert.deepEqual(browser.contexts(), []);
      await assert.rejects(browser.newContext(), /closed/);
    } finally {
      await browser.close();
    }
  });

  it("removes a profile when its launch fails", async () => {
    const { browserType, launches } = engine({
      beforeLaunch: async () => {
        throw new Error("launch refused");
      },
    });
    const browser = persistentLiveBrowser(browserType, { headless: true });
    await assert.rejects(browser.newContext(), /launch refused/);
    await absent(launches[0].directory);
    assert.deepEqual(browser.contexts(), []);
    await browser.close();
  });

  it("retires every peer and profile even when one process close rejects", async () => {
    const { browserType, launches } = engine({ failClose: true });
    const browser = persistentLiveBrowser(browserType, { headless: true });
    await browser.newContext();
    await browser.newContext();
    await assert.rejects(browser.close(), AggregateError);
    for (const launch of launches) {
      assert.equal(launch.closes, 1);
      await absent(launch.directory);
    }
    assert.deepEqual(browser.contexts(), []);
  });

  it("waits for an already-opening device before closing its process and profile", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { browserType, launches } = engine({ beforeLaunch: () => gate });
    const browser = persistentLiveBrowser(browserType, { headless: true });
    const opening = browser.newContext();
    const closing = browser.close();
    await assert.rejects(browser.newContext(), /closed/);
    release();
    await opening;
    await closing;
    assert.equal(launches[0].closes, 1);
    await absent(launches[0].directory);
    assert.deepEqual(browser.contexts(), []);
  });
});
