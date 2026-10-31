/**
 * Source of the virtual-network relay as a Cloudflare Worker.
 *
 * Deployed to a temporary preview account, this gives the WASM lane
 * a real network egress with no vendor account and no claim: the
 * account is anonymous, the deployment is per-run, and the relay is
 * deleted when the run closes. It implements the same `/fetch` and
 * `/close` contract as `vnet.ts`: bearer-authenticated, origin
 * allowlist enforced on every hop including redirects, cookie jar
 * per session (persisted in KV so isolates agree), body capped.
 *
 * Worker-to-workers.dev fetches are refused by Cloudflare (error
 * 1042); operators can bind such targets as services and name them
 * in `SERVICE_BINDINGS_JSON` ({"host-prefix":"BINDING_NAME"}).
 */
export const CLOUDFLARE_RELAY_WORKER_SOURCE = `
const MAX_BODY = 1048576;
async function loadJar(env, sessionId) {
  try {
    return (await env.RELAY_KV.get("jar:" + sessionId, "json")) ?? {};
  } catch { return {}; }
}
async function saveJar(env, sessionId, jar) {
  try { await env.RELAY_KV.put("jar:" + sessionId, JSON.stringify(jar), { expirationTtl: 3600 }); } catch {}
}
function cookieHeader(jar, origin) {
  const entries = Object.entries(jar[origin] ?? {});
  return entries.map(([k, v]) => k + "=" + v).join("; ");
}
function storeCookies(jar, origin, headers) {
  const set = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const line of set) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (!jar[origin]) jar[origin] = {};
    jar[origin][pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
export default {
  async fetch(request, env) {
    if (!env.RELAY_TOKEN || request.headers.get("authorization") !== "Bearer " + env.RELAY_TOKEN)
      return new Response("unauthorized", { status: 401 });
    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response("method", { status: 405 });
    let rpc;
    try { rpc = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
    if (pathname === "/close") {
      try { await env.RELAY_KV.delete("jar:" + String(rpc.sessionId ?? "")); } catch {}
      return Response.json({ ok: true });
    }
    if (pathname !== "/fetch") return new Response("not found", { status: 404 });
    const origins = Array.isArray(rpc.allowedOrigins) ? rpc.allowedOrigins : [];
    if (!rpc.sessionId || !rpc.url || !origins.length)
      return new Response("bad request", { status: 400 });
    if (!["GET", "HEAD", "POST"].includes(rpc.method))
      return new Response("method refused", { status: 405 });
    let url;
    try { url = new URL(rpc.url); } catch { return new Response("bad url", { status: 400 }); }
    if (!origins.includes(url.origin)) return new Response("origin refused", { status: 403 });
    let bindings = {};
    try { bindings = JSON.parse(env.SERVICE_BINDINGS_JSON ?? "{}"); } catch {}
    const jar = await loadJar(env, String(rpc.sessionId));
    let current = url;
    let method = rpc.method;
    let body = typeof rpc.body === "string" ? rpc.body : undefined;
    for (let hop = 0; hop < 8; hop++) {
      const headers = new Headers(rpc.headers ?? {});
      headers.delete("host");
      headers.delete("cookie");
      const cookies = cookieHeader(jar, current.origin);
      if (cookies) headers.set("cookie", cookies);
      const bindingName = Object.keys(bindings).find((p) => current.hostname.startsWith(p));
      const bound = bindingName ? env[bindings[bindingName]] : null;
      const doFetch = bound ? bound.fetch.bind(bound) : fetch;
      const response = await doFetch(current.href, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        redirect: "manual",
      });
      storeCookies(jar, current.origin, response.headers);
      await saveJar(env, String(rpc.sessionId), jar);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return finish(response, current);
        const next = new URL(location, current);
        if (!origins.includes(next.origin))
          return new Response("redirect refused", { status: 403 });
        if (response.status === 303) { method = "GET"; body = undefined; }
        current = next;
        continue;
      }
      return finish(response, current);
    }
    return new Response("too many redirects", { status: 502 });
    async function finish(response, finalUrl) {
      const text = (await response.text()).slice(0, MAX_BODY);
      const headers = {};
      response.headers.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") headers[k] = v; });
      return Response.json({ status: response.status, url: finalUrl.href, headers, bodyText: text });
    }
  },
};
`;
