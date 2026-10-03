// The web the extension is pointed at: one HTTP listener on loopback, reached
// under several host names (Chromium maps `*.test` to 127.0.0.1 through
// `--host-resolver-rules`), so a page, a frame from another origin and a
// lookalike host are three real origins. Every page is a login form built to
// stand for one situation the guard must decide.
import http from "node:http";

const USER = `<input id="user" name="username" autocomplete="username" type="text">`;
const PASS = `<input id="pass" name="password" autocomplete="current-password" type="password">`;

const page = (body, head = "") =>
  `<!doctype html><meta charset="utf-8"><title>login</title>${head}
<style>body{margin:24px;font:16px sans-serif}input{display:block;width:260px;height:32px;margin:12px 0}</style>
<body>${body}</body>`;

// A page that means the extension harm: it hooks the value setter on the
// prototype and on the field itself, listens for every form event, and keeps
// a log a real site's scripts could ship anywhere. `window.__seen` is what it
// learned; the extension must leave it empty.
const HOSTILE = `<script>
  window.__seen = { setterCalls: 0, instanceSetterCalls: 0, events: 0, strings: [] };
  const proto = HTMLInputElement.prototype;
  const native = Object.getOwnPropertyDescriptor(proto, "value");
  Object.defineProperty(proto, "value", {
    configurable: true,
    get() { return native.get.call(this); },
    set(v) { window.__seen.setterCalls++; window.__seen.strings.push(String(v)); native.set.call(this, v); },
  });
  addEventListener("DOMContentLoaded", () => {
    const pass = document.getElementById("pass");
    Object.defineProperty(pass, "value", {
      configurable: true,
      get() { return native.get.call(this); },
      set(v) { window.__seen.instanceSetterCalls++; window.__seen.strings.push(String(v)); native.set.call(this, v); },
    });
    for (const type of ["input", "change", "keydown", "keyup", "focus", "blur"]) {
      document.addEventListener(type, () => { window.__seen.events++; }, true);
    }
  });
</script>`;

const SHADOW_STYLE =
  "<style>input{display:block;width:260px;height:32px;margin:12px 0}</style>";
const PASSKEY_USER = `<input id="user" name="username" autocomplete="username webauthn" type="text">`;

// A login built inside an open shadow root (and, with `inner`, a second one
// inside the first), the way web components ship one. `outer` is markup for
// the outer root; `inner` is markup for a root attached under `#inner-host`.
const shadowPage = (outer, inner) =>
  page(
    `<div id="host"></div>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = ${JSON.stringify(SHADOW_STYLE + outer)};
  const innerHost = root.getElementById("inner-host");
  if (innerHost) {
    innerHost.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(SHADOW_STYLE + (inner ?? ""))};
  }
</script>`,
  );

/** Build the routes; `frameOrigin` is where the cross-origin frame comes from. */
export function pages({ frameOrigin }) {
  return {
    "/plain": page(`<form>${USER}${PASS}</form>`),
    "/hostile": page(`<form>${USER}${PASS}</form>`, HOSTILE),
    // Two fields of the same kind, so a move of focus between them is not
    // caught by the field's kind changing.
    "/two-passwords": page(
      `<form>${USER}${PASS}<input id="pass2" type="password" autocomplete="current-password"></form>`,
    ),
    "/user-only": page(`<form>${USER}</form>`),
    "/opacity-zero": page(
      `<form>${USER}<input id="pass" type="password" autocomplete="current-password" style="opacity:0"></form>`,
    ),
    "/opacity-ancestor": page(
      `<form>${USER}<div id="veil" style="opacity:0">${PASS}</div></form>`,
    ),
    // A transparent layer above the field: it catches every click meant for it.
    "/covered": page(
      `<form>${USER}${PASS}</form>
       <div id="cover" style="position:fixed;inset:0;z-index:9;background:transparent"></div>`,
    ),
    "/offscreen": page(
      `<form>${USER}<input id="pass" type="password" autocomplete="current-password" style="position:absolute;left:-2000px;top:40px"></form>`,
    ),
    "/passkey": page(
      `<form><input id="user" name="username" autocomplete="username webauthn" type="text">${PASS}</form>`,
    ),
    // The passkey field and the password are siblings in one open shadow root
    // with no form: the root, not the document, is where the guard must look.
    "/shadow-passkey": shadowPage(`${PASSKEY_USER}${PASS}`),
    "/shadow-form-passkey": shadowPage(`<form>${PASSKEY_USER}${PASS}</form>`),
    "/shadow-nested-passkey": shadowPage(
      `<div id="inner-host"></div>`,
      `${PASSKEY_USER}${PASS}`,
    ),
    // Controls: a shadow login with no passkey anywhere, and one whose only
    // passkey field lives in another root (not beside it).
    "/shadow-plain": shadowPage(`${USER}${PASS}`),
    "/shadow-other-root-passkey": shadowPage(
      `${PASSKEY_USER}<div id="inner-host"></div>`,
      `${USER}${PASS}`,
    ),
    "/new-password": page(
      `<form>${USER}<input id="pass" type="password" autocomplete="new-password"></form>`,
    ),
    "/frame": page(
      `<iframe id="inner" title="login" src="${frameOrigin}/plain" style="width:420px;height:220px;border:0"></iframe>`,
    ),
    "/frame-same-origin": page(
      `<iframe id="inner" title="login" src="/plain" style="width:420px;height:220px;border:0"></iframe>`,
    ),
  };
}

export async function startSites() {
  const state = { routes: {} };
  const server = http.createServer((req, res) => {
    const html = state.routes[new URL(req.url, "http://x").pathname];
    res.writeHead(html ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html ?? "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = (host) => `http://${host}:${port}`;
  state.routes = pages({ frameOrigin: origin("frame.test") });
  return {
    port,
    /** `http://<host>.test:<port>` */
    origin,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
