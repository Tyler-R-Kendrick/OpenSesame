/**
 * Shared helpers for duress Playwright journeys against the fixture page.
 */
export function qa(page) {
  return page.evaluate(() => {
    if (!window.__duressQa) throw new Error("fixture API missing");
    return true;
  });
}

export async function callQa(page, fnSource, ...args) {
  return page.evaluate(
    async ({ src, args }) => {
      const api = window.__duressQa;
      // eslint-disable-next-line no-new-func
      const fn = new Function("api", "args", `return (${src})(api, ...args);`);
      return await fn(api, args);
    },
    { src: fnSource, args },
  );
}

/** Encode Uint8Array as base64 for crossing the Playwright bridge. */
export function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(s) {
  return Uint8Array.from(Buffer.from(s, "base64"));
}
