// CDP announces a worker before Chromium finishes installing its extension
// bindings. Discovery alone is not readiness to inspect extension storage.
export async function readyWorker(
  context,
  { attempts = 200, pause = () => new Promise((r) => setTimeout(r, 50)) } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const worker of context.serviceWorkers()) {
      if (!worker.url().startsWith("chrome-extension://")) continue;
      try {
        const ready = await worker.evaluate(async () => {
          chrome.runtime.getURL("/");
          // Empty key lists check the API without reading any stored values.
          await chrome.storage.local.get([]);
          await chrome.storage.session.get([]);
          await chrome.scripting.getRegisteredContentScripts();
          return true;
        });
        if (ready) return worker;
      } catch {
        // A worker can stop during discovery; inspect its replacement next.
      }
    }
    await pause();
  }
  throw new Error(
    "extension worker APIs did not become ready within 10 seconds",
  );
}
