// Reading the extension's own state from its service worker, the way its
// background sees it. Nothing here is what a person or a page can do; it is how
// a test checks what the extension holds and what the browser did with it.

/** Ids of the guard registrations, one per site switched on. */
export async function guards(session) {
  const worker = await session.worker();
  return worker.evaluate(async () => {
    const all = await chrome.scripting.getRegisteredContentScripts();
    return all.map((script) => script.id);
  });
}

/** Wait until the guard registrations number `count`. */
export async function waitForGuards(session, count) {
  for (let tries = 0; tries < 50; tries++) {
    const now = await guards(session);
    if (now.length === count) return now;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return guards(session);
}

/** Everything the extension keeps in `storage.local` and `storage.session`, as JSON text. */
export async function storedState(session) {
  const worker = await session.worker();
  return worker.evaluate(async () =>
    JSON.stringify([
      await chrome.storage.local.get(null),
      await chrome.storage.session.get(null),
    ]),
  );
}

/**
 * Ask the daemon's value route as the extension, with its own pairing token
 * and the `Origin` the browser stamps on its requests, naming `origin` as the
 * site. Answers the status and whether the body carried a value.
 */
export async function askDaemonFor(session, origin, reference = "Dev/app") {
  const worker = await session.worker();
  return worker.evaluate(
    async (asked) => {
      const { fillPairingToken } =
        await chrome.storage.local.get("fillPairingToken");
      // The daemon fixture listens only on loopback; this exercises its paired local HTTP protocol.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const response = await fetch("http://127.0.0.1:18790/v1/fill", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fillPairingToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reference: asked.reference,
          origin: asked.origin,
          field: "password",
        }),
      });
      const text = await response.text();
      return { status: response.status, hasValue: text.includes("value") };
    },
    { origin, reference },
  );
}
