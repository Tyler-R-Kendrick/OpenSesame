/**
 * The browser's push subscription, stood in for in headless Chromium.
 *
 * Chromium without Google services cannot subscribe: there is no push service
 * to hand out an endpoint. What the app relies on from the browser is small —
 * `pushManager.subscribe()` answers with an endpoint and the two keys that
 * RFC 8291 encrypts to, `getSubscription()` answers with it again, and
 * `unsubscribe()` ends it — so that is what this provides, backed by *real*
 * subscriptions minted by the stand-in push service (a P-256 key and an auth
 * secret whose private halves the stand-in holds, so it can decrypt what the
 * Host's adapter sends). The app's own code makes every call; this only
 * answers them, and records them for the walk to assert on.
 *
 * State lives in Node, so a reload keeps the subscription as a browser does.
 */

/** Install the shim on a context. `mint` makes a registered subscription. */
export async function installPushShim(context, mint) {
  const state = {
    held: null,
    /** Subscriptions to hand out next, before minting new ones. */
    queue: [],
    subscribed: [],
    unsubscribed: [],
    /** Application server keys the app subscribed with. */
    keys: [],
    /** Make `subscribe()` never answer, as a push service that is unreachable. */
    hang: false,
  };
  const describe = (sub) => ({
    endpoint: sub.endpoint,
    keys: sub.keys,
    id: sub.id,
  });
  await context.exposeBinding("__pushShim", async (_source, op, arg) => {
    if (op === "get") return state.held ? describe(state.held) : null;
    if (op === "subscribe") {
      if (state.hang) return new Promise(() => {});
      state.keys.push(arg);
      state.held = state.queue.shift() ?? mint();
      state.subscribed.push(state.held);
      return describe(state.held);
    }
    if (op === "unsubscribe") {
      if (!state.held) return false;
      state.unsubscribed.push(state.held);
      state.held = null;
      return true;
    }
    return null;
  });
  await context.addInitScript(() => {
    const bytes = (b64url) => {
      const padded = b64url + "=".repeat((4 - (b64url.length % 4)) % 4);
      return Uint8Array.from(
        atob(padded.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      ).buffer;
    };
    const wrap = (s, key) => ({
      endpoint: s.endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: key ?? null },
      getKey: (name) => bytes(s.keys[name === "auth" ? "auth" : "p256dh"]),
      toJSON: () => ({
        endpoint: s.endpoint,
        expirationTime: null,
        keys: s.keys,
      }),
      unsubscribe: () => window.__pushShim("unsubscribe"),
    });
    let appKey = null;
    PushManager.prototype.subscribe = async (options) => {
      const k = options.applicationServerKey;
      const raw = new Uint8Array(
        k instanceof ArrayBuffer ? k : (k.buffer ?? k),
      );
      let text = "";
      for (const byte of raw) text += String.fromCharCode(byte);
      const b64 = btoa(text)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      appKey = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      );
      return wrap(await window.__pushShim("subscribe", b64), appKey);
    };
    PushManager.prototype.getSubscription = async () => {
      const held = await window.__pushShim("get");
      return held ? wrap(held, appKey) : null;
    };
  });
  return state;
}
