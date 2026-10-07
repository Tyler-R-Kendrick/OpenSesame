/**
 * Evidence of the plugin tiles (ADR 0150 §7) in every state a daemon
 * reports — installed and off, on with tripwires, forced off, not installed —
 * without a daemon: a journey (or one of its screens) names `daemonStub`, and
 * this answers the plugin routes the way `crates/daemon` does. CORS for the
 * page's own origin only; the pairing code traded once for a key; the plugin
 * routes only with that key; a switch refused for what is not installed.
 *
 * `reloadUnlock` is the sealed vault's `reload`: a new section loads with the
 * app root, and a vault that is not a guest's opens with its password.
 */
import { unlockWithPin } from "./pages-journey.mjs";

/** 32 bytes, unpadded base64url: the shape the page accepts. Not a secret. */
const EVIDENCE_KEY = "RXZpZGVuY2UtZGFlbW9uLWtleS1ub3QtcmVhbC0wMSE";

function bodyOf(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

function reply(origin) {
  const headers = { "access-control-allow-origin": origin, vary: "Origin" };
  return {
    preflight: {
      status: 204,
      headers: {
        ...headers,
        "access-control-allow-methods": "GET, PUT, POST, DELETE",
        "access-control-allow-headers": "authorization, content-type",
      },
    },
    json: (status, body) => ({
      status,
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

/** `POST /v1/plugins/pairing`: the stub's one code, traded for the key. */
function exchange(request, stub, origin, json) {
  const taken = bodyOf(request).code === stub.code;
  console.log(`  daemon: pairing code ${taken ? "taken" : "refused"}`);
  return taken
    ? json(201, { id: "evidence", origin, token: EVIDENCE_KEY })
    : json(403, { error: "pairing_refused" });
}

/** `PUT /v1/plugins/{id}`: only what is installed switches. */
function toggle(request, state, json) {
  if (!state || request.method() !== "PUT")
    return json(404, { error: "not_found" });
  if (!state.installed) return json(404, { error: "not_installed" });
  state.enabled = bodyOf(request).enabled === true;
  state.active = state.enabled && !state.forced_off;
  console.log(`  daemon: ${state.id} switched ${state.enabled ? "on" : "off"}`);
  return json(200, state);
}

/** The routes the paired key opens. */
function pluginRoute(request, url, stub, plugins, json) {
  if (request.headers().authorization !== `Bearer ${EVIDENCE_KEY}`)
    return json(401, { error: "plugin_pairing_required" });
  if (url.pathname === "/v1/plugins") return json(200, { plugins });
  const [, id, notices] =
    url.pathname.match(/^\/v1\/plugins\/([a-z-]+)(\/notices)?$/) ?? [];
  if (id && notices) return json(200, { notices: stub.notices?.[id] ?? [] });
  return toggle(
    request,
    plugins.find((plugin) => plugin.id === id),
    json,
  );
}

/** Answer one plugin-route request the way the daemon would. */
function answer(request, url, stub, plugins, origin) {
  const { preflight, json } = reply(origin);
  if (request.method() === "OPTIONS") return preflight;
  if (url.pathname === "/v1/plugins/pairing" && request.method() === "POST")
    return exchange(request, stub, origin, json);
  return pluginRoute(request, url, stub, plugins, json);
}

/**
 * Serve a screen's `daemonStub`, else the journey's (`{ url, code, plugins,
 * notices }`), for one page.
 */
export async function stubJourneyDaemon(page, screen, journey, origin) {
  const stub = screen.daemonStub ?? journey.daemonStub;
  if (!stub) return;
  const plugins = structuredClone(stub.plugins);
  await page.route(`${stub.url}/**`, (route) => {
    const request = route.request();
    return route.fulfill(
      answer(request, new URL(request.url()), stub, plugins, origin),
    );
  });
}

export function pluginSteps() {
  return {
    async reloadUnlock(page) {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(5200);
      await unlockWithPin(page);
      await page.waitForTimeout(1400);
    },
  };
}
