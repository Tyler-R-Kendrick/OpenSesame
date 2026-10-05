import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";

declare const chrome: {
  storage: {
    local: {
      get(key: null): Promise<Record<string, string>>;
      set(values: Record<string, string>): Promise<void>;
    };
  };
};

test("built runner seals credentials and rejects cross-origin ciphertext replay", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "opensesame-runner-e2e-"));
  const extension = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.PLAYWRIGHT_CHROMIUM
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    const customerA = "https://customer-a.example";
    const customerB = "https://customer-b.example";
    const passwordA = `fixture-a-${crypto.randomUUID()}`;
    const passwordB = `fixture-b-${crypto.randomUUID()}`;
    const save = async (origin: string, password: string) => {
      await page.locator('#credential [name="origin"]').fill(origin);
      await page.locator('#credential [name="username"]').fill("fixture-user");
      await page.locator('#credential [name="password"]').fill(password);
      await page.getByRole("button", { name: "Save credential" }).click();
      await expect(page.locator("#credentials")).toContainText(origin);
    };
    await save(customerA, passwordA);
    const first = await page.evaluate(() => chrome.storage.local.get(null));
    const [keyA] = Object.keys(first).filter((key) =>
      key.startsWith("runner.vault."),
    );
    if (!keyA) throw new Error("missing first credential");
    await save(customerB, passwordB);
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    const [keyB] = Object.keys(stored).filter(
      (key) => key.startsWith("runner.vault.") && key !== keyA,
    );
    if (!keyB) throw new Error("missing second credential");
    const ciphertext = stored[keyA];
    if (!ciphertext) throw new Error("missing fixture ciphertext");
    expect(ciphertext).toMatch(/^osc2\./);
    const serialized = JSON.stringify(stored);
    for (const secret of [passwordA, passwordB, customerA, customerB]) {
      expect(serialized).not.toContain(secret);
    }
    // The same stored CryptoKey survives restart; both credentials reopen.
    await page.reload();
    await expect(page.locator("#credentials")).toContainText(customerA);
    await expect(page.locator("#credentials")).toContainText(customerB);
    await page.evaluate(
      ({ key, value }) => chrome.storage.local.set({ [key]: value }),
      {
        key: keyB,
        value: ciphertext,
      },
    );
    await page.reload();
    await expect(page.locator("#credentials")).toContainText(customerA);
    await expect(page.locator("#credentials")).not.toContainText(customerB);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
